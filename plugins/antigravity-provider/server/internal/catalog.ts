import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { spawnProcess } from "@getpaseo/plugin/server";
import type {
  ProviderCatalogOptions,
  ProviderLaunch,
  ProviderStatus,
  ProviderStatusRequest,
} from "@getpaseo/plugin/server/provider";
import { signalProcess } from "./signals.js";

const MIN_AGY_VERSION = "1.5.0";
const STATUS_TIMEOUT_MS = 10_000;
const RELEVANT_ENV_KEYS = [
  "HOME",
  "PATH",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "ANTIGRAVITY_API_KEY",
  "AGY_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

export function defaultLaunch(launch?: ProviderLaunch): ProviderLaunch {
  if (launch) return launch;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { command: "agy", args: ["acp"], env };
}

export function formatDiagnostic(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("not signed in") || lower.includes("authentication required")) {
    return `${message}\nRun 'agy' to sign in, or set an API key.`;
  }
  return message;
}

export async function getCatalogCacheKey(options: ProviderCatalogOptions): Promise<string> {
  const launch = defaultLaunch(options.launch);
  const envEntries: Array<[string, string]> = [];
  for (const key of RELEVANT_ENV_KEYS) {
    if (launch.env[key]) envEntries.push([key, launch.env[key]]);
  }
  for (const [key, value] of Object.entries(launch.env).sort(([a], [b]) => a.localeCompare(b))) {
    if (key.startsWith("AGY_")) envEntries.push([key, value]);
  }
  return JSON.stringify({
    scope: options.scope,
    cwd: options.scope === "workspace" ? options.cwd : null,
    command: launch.command,
    args: launch.args,
    env: envEntries,
  });
}

export async function getStatus(request: ProviderStatusRequest): Promise<ProviderStatus> {
  const launch = defaultLaunch(request.launch);
  let version: string;
  try {
    version = await probeVersion(launch);
  } catch (error) {
    return {
      available: false,
      diagnostic:
        error instanceof Error ? formatDiagnostic(error.message) : formatDiagnostic(String(error)),
    };
  }
  if (!isVersionAtLeast(version, MIN_AGY_VERSION)) {
    return {
      available: false,
      diagnostic: `Antigravity CLI ${MIN_AGY_VERSION} or newer is required for ACP support (found ${version || "unknown"}). Update Antigravity CLI to use this provider.`,
    };
  }
  try {
    await probeAcpInitialize(launch);
    return { available: true };
  } catch (error) {
    return {
      available: false,
      diagnostic:
        error instanceof Error ? formatDiagnostic(error.message) : formatDiagnostic(String(error)),
    };
  }
}

function probeVersion(launch: ProviderLaunch): Promise<string> {
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
      void Promise.resolve(killChild(child.pid)).then(() => {
        reject(new Error("Antigravity version check timed out"));
        return undefined;
      }, reject);
    }, STATUS_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on("error", (error: Error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `agy exited with code ${code}`));
    });
  });
}

function probeAcpInitialize(launch: ProviderLaunch): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(launch.command, launch.args, {
      cwd: homedir(),
      env: launch.env,
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
    let settled = false;
    let stderr = "";
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      child.stdin.end();
      void killChild(child.pid);
      if (err) reject(err);
      else resolve();
    };
    const deadline = setTimeout(
      () => finish(new Error(stderr.trim() || "Antigravity ACP initialization timed out")),
      STATUS_TIMEOUT_MS,
    );
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on("error", (error: Error) => finish(error));
    child.on("close", (code) => {
      if (!settled) {
        finish(new Error(stderr.trim() || `Antigravity ACP exited with code ${code}`));
      }
    });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as {
          id?: number;
          error?: { message?: string };
          result?: unknown;
        };
        if (msg.id !== 1) return;
        if (msg.error) finish(new Error(msg.error.message || JSON.stringify(msg.error)));
        else finish();
      } catch {
        // Ignore non-JSON lines before JSON-RPC response.
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      })}\n`,
    );
  });
}

function killChild(pid: number | undefined): void | Promise<void> {
  if (!pid) return;
  return signalProcess({ platform: process.platform, pid, signal: "SIGKILL" });
}

function isVersionAtLeast(actual: string, minimum: string): boolean {
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
