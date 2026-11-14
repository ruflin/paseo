import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { spawnProcess } from "@getpaseo/plugin/server";
import { signalProcess } from "./signals.js";
import { AntigravityError, diagnostic, MIN_AGY_VERSION } from "./wire.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const VERSION_TIMEOUT_MS = 10_000;

export interface AcpIncomingRequest {
  id: string | number;
  method: string;
  params: unknown;
  reply(result: unknown): void;
  fail(code: number, message: string): void;
}

export interface AcpClientOptions {
  launch: ProviderLaunch;
  cwd: string;
  env?: Readonly<Record<string, string>>;
  onNotification?(method: string, params: unknown): void;
  onRequest?(request: AcpIncomingRequest): void;
  onExit?(error: AntigravityError | null): void;
}

export interface AcpClient {
  readonly isClosed: boolean;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  stop(reason: "close" | "interrupt"): Promise<void>;
}

interface PendingRpc {
  method: string;
  timer?: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export function defaultLaunch(launch?: ProviderLaunch): ProviderLaunch {
  if (launch) return launch;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { command: "agy", args: ["acp"], env };
}

export function startAcpClient(options: AcpClientOptions): AcpClient {
  const env = options.env ? { ...options.launch.env, ...options.env } : options.launch.env;
  const child = spawnProcess(options.launch.command, options.launch.args, {
    cwd: options.cwd,
    env,
    stdio: "pipe",
    detached: process.platform !== "win32",
  });

  let nextId = 1;
  let state: "open" | "stopping" | "closed" = "open";
  let stderr = "";
  let cleanup: Promise<void> | undefined;
  const pending = new Map<string | number, PendingRpc>();

  let resolveExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });

  function buildExitError(message: string, code: string): AntigravityError {
    const tail = stderr.trim();
    return new AntigravityError(diagnostic(tail ? `${message}\n${tail}` : message), code);
  }

  function rejectAll(error: Error): void {
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  child.on("error", (error: Error) => {
    const failure = buildExitError(error.message, "SPAWN_ERROR");
    rejectAll(failure);
    if (state === "open") {
      state = "closed";
      resolveExited();
      options.onExit?.(failure);
    }
  });

  child.on("close", (code, signal) => {
    const previousState = state;
    state = "closed";
    resolveExited();
    if (previousState === "stopping") {
      rejectAll(new AntigravityError("Antigravity session closed", "SESSION_CLOSED"));
      return;
    }
    const reason = code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`;
    const failure =
      code === 0 && !stderr.trim()
        ? null
        : buildExitError(`Antigravity ACP process exited (${reason})`, "PROCESS_EXIT");
    rejectAll(
      failure ?? new AntigravityError(`Antigravity ACP process exited (${reason})`, "PROCESS_EXIT"),
    );
    if (previousState === "open") {
      options.onExit?.(failure);
    }
  });

  function sendJson(payload: unknown): void {
    if (state !== "open" || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function handleResponse(msg: Record<string, unknown>, id: string | number): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if ("error" in msg && msg.error !== undefined) {
      const err =
        typeof msg.error === "object" && msg.error !== null
          ? (msg.error as Record<string, unknown>)
          : {};
      const message = typeof err.message === "string" ? err.message : JSON.stringify(msg.error);
      const code =
        typeof err.code === "number" || typeof err.code === "string"
          ? String(err.code)
          : "ACP_ERROR";
      entry.reject(new AntigravityError(diagnostic(message), code));
      return;
    }
    entry.resolve(msg.result);
  }

  function handleIncomingRequest(
    msg: Record<string, unknown>,
    id: string | number,
    method: string,
  ): void {
    const incoming: AcpIncomingRequest = {
      id,
      method,
      params: msg.params,
      reply(result) {
        sendJson({ jsonrpc: "2.0", id, result });
      },
      fail(code, message) {
        sendJson({ jsonrpc: "2.0", id, error: { code, message } });
      },
    };
    if (options.onRequest) options.onRequest(incoming);
    else incoming.fail(-32601, `Method not found: ${method}`);
  }

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim() || state !== "open") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const msg = parsed as Record<string, unknown>;
    const hasId = typeof msg.id === "number" || typeof msg.id === "string";

    if (hasId && ("result" in msg || "error" in msg)) {
      handleResponse(msg, msg.id as string | number);
      return;
    }
    if (hasId && typeof msg.method === "string") {
      handleIncomingRequest(msg, msg.id as string | number, msg.method);
      return;
    }
    if (typeof msg.method === "string") {
      options.onNotification?.(msg.method, msg.params);
    }
  });

  return {
    get isClosed() {
      return state !== "open";
    },
    request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
      if (state !== "open") {
        return Promise.reject(
          new AntigravityError("Antigravity ACP client is closed", "SESSION_CLOSED"),
        );
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const entry: PendingRpc = { method, resolve, reject };
        if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
          entry.timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            reject(
              buildExitError(
                `Antigravity ACP request '${method}' timed out after ${timeoutMs}ms`,
                "ACP_TIMEOUT",
              ),
            );
          }, timeoutMs);
        }
        pending.set(id, entry);
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
          (error) => {
            if (!error) return;
            if (!pending.delete(id)) return;
            if (entry.timer) clearTimeout(entry.timer);
            reject(new AntigravityError(error.message, "WRITE_ERROR"));
          },
        );
      });
    },
    notify(method, params) {
      sendJson({ jsonrpc: "2.0", method, params });
    },
    async stop(reason) {
      if (process.platform === "win32") await cleanup;
      if (state === "closed") return;
      state = "stopping";
      rejectAll(new AntigravityError("Antigravity session stopped", "SESSION_CLOSED"));
      if (process.platform === "win32") {
        cleanup = Promise.resolve(signalGroup(child, "SIGKILL"));
        await cleanup;
        await exited;
        return;
      }
      if (reason === "close") {
        child.stdin.end();
      } else {
        signalGroup(child, "SIGTERM");
      }
      const terminate = setTimeout(() => signalGroup(child, "SIGTERM"), 1_000);
      const kill = setTimeout(() => signalGroup(child, "SIGKILL"), 2_000);
      await exited;
      clearTimeout(terminate);
      clearTimeout(kill);
      signalGroup(child, "SIGKILL");
    },
  };
}

function signalGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void | Promise<void> {
  if (!child.pid) return;
  return signalProcess({ platform: process.platform, pid: child.pid, signal });
}

export function probeVersion(launch: ProviderLaunch): Promise<string> {
  const baseArgs =
    launch.args[launch.args.length - 1] === "acp" ? launch.args.slice(0, -1) : launch.args;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(launch.command, [...baseArgs, "--version"], {
      env: launch.env,
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    const deadline = setTimeout(() => {
      void Promise.resolve(signalGroup(child, "SIGKILL")).then(() => {
        reject(new AntigravityError("Antigravity version check timed out", "PROBE_TIMEOUT"));
        return undefined;
      }, reject);
    }, VERSION_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on("error", (error: Error) => {
      clearTimeout(deadline);
      reject(new AntigravityError(error.message, "SPAWN_ERROR"));
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new AntigravityError(
            diagnostic(stderr.trim() || `agy exited with code ${code}`),
            "PROBE_ERROR",
          ),
        );
    });
  });
}

export function isVersionAtLeast(actual: string, minimum = MIN_AGY_VERSION): boolean {
  const parse = (raw: string): [number, number, number] | null => {
    const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = parse(actual);
  const b = parse(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}
