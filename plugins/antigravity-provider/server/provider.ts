import { homedir } from "node:os";
import {
  negotiateProviderCapabilities,
  PROVIDER_PROTOCOL_VERSION,
  type ProviderCapability,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderRegistration,
  type ProviderSessionSummary,
} from "@getpaseo/plugin/server/provider";
import { defaultLaunch, startAcpClient } from "./internal/acp-client.js";
import { getCatalog, getCatalogCacheKey, getStatus } from "./internal/catalog.js";
import { AntigravitySession } from "./internal/session.js";
import {
  ACP_PROTOCOL_VERSION,
  AcpInitializeResultSchema,
  AcpSessionListResultSchema,
  AntigravityError,
  diagnostic,
} from "./internal/wire.js";

const SUPPORTED_CAPABILITIES: readonly ProviderCapability[] = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "session.configure",
  "session.list",
  "session.persistence",
  "permission",
];

export function createAntigravityProvider(): ProviderRegistration {
  return {
    id: "antigravity",
    label: "Antigravity",
    description: "Run Antigravity via ACP",
    icon: "icon.svg",
    command: ["agy", "acp"],
    status: getStatus,
    getCatalogCacheKey,
    connect(request) {
      if (!request.versions.includes(PROVIDER_PROTOCOL_VERSION)) {
        return Promise.reject(
          new AntigravityError(
            `Unsupported protocol version: ${request.versions.join(", ")}`,
            "UNSUPPORTED_PROTOCOL",
          ),
        );
      }
      const launch = defaultLaunch(request.launch);
      const negotiated = negotiateProviderCapabilities(
        SUPPORTED_CAPABILITIES,
        request.capabilities,
      );
      return Promise.resolve(createConnection(launch, negotiated));
    },
  };
}

function createConnection(
  launch: ReturnType<typeof defaultLaunch>,
  capabilities: readonly ProviderCapability[],
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, AntigravitySession>();
  let closed = false;
  let pending: Promise<void> = Promise.resolve();

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) listener(event);
  }

  function enqueue(work: () => Promise<void>): Promise<void> {
    const next = pending.then(work, work);
    pending = next.catch(() => undefined);
    return next;
  }

  function failed(input: { requestId?: string }, error: unknown): void {
    if (!input.requestId) return;
    emit({
      type: "request.failed",
      requestId: input.requestId,
      error: {
        message: error instanceof Error ? diagnostic(error.message) : String(error),
        ...(error instanceof AntigravityError && error.code ? { code: error.code } : {}),
      },
    });
  }

  async function listSessions(
    input: Extract<ProviderInput, { type: "sessions" }>,
  ): Promise<ProviderSessionSummary[]> {
    const client = startAcpClient({ launch, cwd: input.cwd ?? homedir() });
    try {
      AcpInitializeResultSchema.parse(
        await client.request("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
      );
      const listed = AcpSessionListResultSchema.parse(
        await client.request("session/list", input.cwd ? { cwd: input.cwd } : {}),
      );
      const needle = input.query?.trim().toLowerCase();
      let filtered = listed.sessions.filter((entry) => {
        if (input.cwd && entry.cwd !== input.cwd) return false;
        if (!needle) return true;
        return (
          entry.sessionId.toLowerCase().includes(needle) ||
          (entry.title?.toLowerCase().includes(needle) ?? false) ||
          entry.cwd.toLowerCase().includes(needle)
        );
      });
      if (input.limit !== undefined && input.limit >= 0) {
        filtered = filtered.slice(0, input.limit);
      }
      return filtered.map((entry) => {
        const summary: ProviderSessionSummary = {
          persistence: { version: 1, data: { sessionId: entry.sessionId } },
          cwd: entry.cwd,
        };
        if (entry.title) summary.title = entry.title;
        if (entry.updatedAt) summary.updatedAt = entry.updatedAt;
        return summary;
      });
    } finally {
      await client.stop("close").catch(() => undefined);
    }
  }

  return {
    version: PROVIDER_PROTOCOL_VERSION,
    capabilities,
    send(input) {
      if (closed) {
        return Promise.reject(new AntigravityError("Antigravity connection is closed", "CLOSED"));
      }
      if (input.type === "session.permission") {
        const session = sessions.get(input.sessionId);
        if (session) session.respondPermission(input.permissionId, input.response);
        return Promise.resolve();
      }
      return enqueue(async () => {
        if (closed) return;
        switch (input.type) {
          case "catalog":
            try {
              const catalog = await getCatalog(launch, input.cwd);
              emit({ type: "catalog", requestId: input.requestId, catalog });
            } catch (error) {
              failed(input, error);
            }
            return;
          case "sessions":
            try {
              const found = await listSessions(input);
              emit({ type: "sessions", requestId: input.requestId, sessions: found });
            } catch (error) {
              failed(input, error);
            }
            return;
          case "session.open":
            if (sessions.has(input.sessionId)) {
              failed(
                input,
                new AntigravityError(
                  `Session ${input.sessionId} already exists`,
                  "DUPLICATE_SESSION",
                ),
              );
              return;
            }
            try {
              const session = new AntigravitySession(input.sessionId, {
                launch,
                capabilities,
                emit,
                onTerminated: () => {
                  sessions.delete(input.sessionId);
                },
              });
              sessions.set(input.sessionId, session);
              await session.open(input);
            } catch (error) {
              sessions.delete(input.sessionId);
              failed(input, error);
            }
            return;
          case "session.prompt": {
            const session = sessions.get(input.sessionId);
            if (!session) {
              emit({
                type: "session.prompt_result",
                sessionId: input.sessionId,
                clientMessageId: input.prompt.clientMessageId,
                result: {
                  type: "failed",
                  error: { message: `Unknown session: ${input.sessionId}` },
                },
              });
              return;
            }
            await session.prompt(input.prompt);
            return;
          }
          case "session.interrupt": {
            const session = sessions.get(input.sessionId);
            if (!session) {
              failed(input, new AntigravityError(`Unknown session: ${input.sessionId}`));
              return;
            }
            try {
              await session.interrupt();
              emit({ type: "request.completed", requestId: input.requestId });
            } catch (error) {
              failed(input, error);
            }
            return;
          }
          case "session.configure": {
            const session = sessions.get(input.sessionId);
            if (!session) {
              failed(input, new AntigravityError(`Unknown session: ${input.sessionId}`));
              return;
            }
            try {
              await session.configure(input.changes);
              emit({ type: "request.completed", requestId: input.requestId });
            } catch (error) {
              failed(input, error);
            }
            return;
          }
          case "session.close": {
            const session = sessions.get(input.sessionId);
            sessions.delete(input.sessionId);
            if (session) {
              await session.close();
            }
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          default:
            failed(
              input,
              new AntigravityError(
                `Unsupported provider input: ${input.type}`,
                "UNSUPPORTED_INPUT",
              ),
            );
        }
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      await pending;
      await Promise.all([...sessions.values()].map((session) => session.close()));
      sessions.clear();
      listeners.clear();
    },
  };
}
