import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PROVIDER_CAPABILITIES,
  ProviderEventSchema,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderLaunch,
} from "@getpaseo/plugin/server/provider";
import { afterEach, describe, expect, it } from "vitest";
import { createAntigravityProvider } from "./provider.js";

const FAKE_AGY = new URL("../test/agy.mjs", import.meta.url).pathname;
const ICON_PATH = new URL("../icon.svg", import.meta.url).pathname;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix = "paseo-agy-runacp-test-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function tempLog(): string {
  return path.join(tempDir(), "agy.jsonl");
}

function readLog(logPath: string): Array<Record<string, unknown>> {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function testLaunch(extraEnv: Record<string, string> = {}): ProviderLaunch {
  return {
    command: process.execPath,
    args: [FAKE_AGY, "acp"],
    env: {
      PATH: process.env.PATH ?? "",
      ...extraEnv,
    },
  };
}

async function openHarness(extraEnv: Record<string, string> = {}): Promise<{
  connection: ProviderConnection;
  events: ProviderEvent[];
}> {
  const provider = createAntigravityProvider();
  const events: ProviderEvent[] = [];
  const connection = await provider.connect({
    versions: [1],
    capabilities: [...PROVIDER_CAPABILITIES],
    launch: testLaunch(extraEnv),
  });
  connection.onEvent((event) => {
    ProviderEventSchema.parse(event);
    events.push(event);
  });
  return { connection, events };
}

async function waitFor<T extends ProviderEvent>(
  events: ProviderEvent[],
  predicate: (event: ProviderEvent) => event is T,
  requestId?: string,
): Promise<T> {
  await expect
    .poll(
      () => {
        if (requestId) {
          const failure = events.find(
            (e): e is Extract<ProviderEvent, { type: "request.failed" }> =>
              e.type === "request.failed" && e.requestId === requestId,
          );
          if (failure) throw new Error(`Request ${requestId} failed: ${failure.error.message}`);
        }
        return events.find(predicate);
      },
      { timeout: 5_000 },
    )
    .toBeDefined();
  return events.find(predicate)!;
}

describe("antigravity-provider (runAcpProvider)", () => {
  it("exposes expected metadata and self-contained icon", () => {
    const provider = createAntigravityProvider();
    expect(provider.id).toBe("antigravity");
    expect(provider.command).toEqual(["agy", "acp"]);
    const svg = readFileSync(ICON_PATH, "utf8");
    expect(svg).toContain("<svg");
    expect(svg).not.toMatch(/href=|xlink:href=|<script/i);
  });

  it("checks CLI version >= 1.5.0 and ACP initialize in status()", async () => {
    const provider = createAntigravityProvider();
    expect(await provider.status?.({ launch: testLaunch() })).toEqual({ available: true });

    const oldStatus = await provider.status?.({
      launch: testLaunch({ AGY_TEST_VERSION: "1.2.13" }),
    });
    expect(oldStatus?.available).toBe(false);
    expect(oldStatus?.diagnostic).toContain("1.5.0");

    const authStatus = await provider.status?.({
      launch: testLaunch({ AGY_TEST_STARTUP: "auth" }),
    });
    expect(authStatus?.available).toBe(false);
    expect(authStatus?.diagnostic).toContain("Run 'agy' to sign in");
  });

  it("computes workspace and environment aware catalog cache keys", async () => {
    const provider = createAntigravityProvider();
    const kGlobal = await provider.getCatalogCacheKey?.({ scope: "global", launch: testLaunch() });
    const kWsA = await provider.getCatalogCacheKey?.({
      scope: "workspace",
      cwd: "/repo-a",
      launch: testLaunch(),
    });
    const kWsB = await provider.getCatalogCacheKey?.({
      scope: "workspace",
      cwd: "/repo-b",
      launch: testLaunch(),
    });
    expect(kGlobal).not.toBe(kWsA);
    expect(kWsA).not.toBe(kWsB);
  });

  it("discovers catalog with per-model thinking options, marks auto unattended, and closes probe session", async () => {
    const logPath = tempLog();
    const cwd = tempDir();
    const { connection, events } = await openHarness({ AGY_TEST_LOG: logPath });
    try {
      await connection.send({ type: "catalog", requestId: "cat-1", cwd });
      const ev = await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "catalog" }> =>
          e.type === "catalog" && e.requestId === "cat-1",
        "cat-1",
      );
      expect(ev.catalog.models.map((m) => m.id)).toEqual(["gemini-4-argon", "gemini-4-hydrogen"]);
      const hydrogen = ev.catalog.models.find((m) => m.id === "gemini-4-hydrogen");
      expect(hydrogen?.thinkingOptions?.map((t) => t.id)).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      expect(ev.catalog.modes.find((m) => m.id === "auto")?.isUnattended).toBe(true);
      expect(ev.catalog.modes.find((m) => m.id === "default")?.isUnattended).toBe(false);

      const log = readLog(logPath);
      expect(log.some((entry) => entry.method === "session/close")).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("lists sessions filtered strictly by requested cwd", async () => {
    const cwdA = tempDir();
    const cwdB = tempDir();
    const { connection, events } = await openHarness({
      AGY_TEST_LIST_CWD_A: cwdA,
      AGY_TEST_LIST_CWD_B: cwdB,
    });
    try {
      await connection.send({ type: "sessions", requestId: "list-1", cwd: cwdA });
      const ev = await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "sessions" }> =>
          e.type === "sessions" && e.requestId === "list-1",
        "list-1",
      );
      expect(
        ev.sessions.map((s) => (s.persistence.data as { sessionId: string }).sessionId),
      ).toEqual(["sess-a", "sess-a2"]);
    } finally {
      await connection.close();
    }
  });

  it("opens session via runAcpProvider with antigravity systemPrompt meta, MCP servers, commands, streaming, tools, permissions, config, cancel, and resume/load", async () => {
    const logPath = tempLog();
    const cwd = tempDir();
    const { connection, events } = await openHarness({ AGY_TEST_LOG: logPath });
    try {
      await connection.send({
        type: "session.open",
        requestId: "open-1",
        sessionId: "s-1",
        history: "skip",
        config: {
          cwd,
          env: { AGY_SESSION_VALUE: "override" },
          systemPrompt: "Be concise.",
          mcpServers: {
            paseo: {
              type: "http",
              url: "http://127.0.0.1:9999/mcp",
              headers: { Authorization: "Bearer tok" },
            },
          },
          settings: {},
          persist: true,
        },
      });
      await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "session.ready" }> =>
          e.type === "session.ready" && e.sessionId === "s-1",
        "open-1",
      );

      const cmds = events.find((e) => e.type === "session.commands");
      expect(cmds?.type === "session.commands" ? cmds.commands.map((c) => c.name) : []).toEqual([
        "compact",
        "plan",
      ]);

      const log = readLog(logPath);
      const newCall = log.find((entry) => entry.method === "session/new") as
        | { params: { _meta?: Record<string, unknown>; mcpServers?: unknown } }
        | undefined;
      expect(newCall?.params._meta).toMatchObject({
        antigravity: { systemPrompt: { append: "Be concise." } },
      });

      await connection.send({
        type: "session.prompt",
        sessionId: "s-1",
        prompt: {
          clientMessageId: "t-tools",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "TOOLS" }] },
        },
      });
      await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
          e.type === "session.turn" && e.turnId === "acp:t-tools" && e.state === "completed",
      );

      const tools = events
        .filter(
          (e): e is Extract<ProviderEvent, { type: "timeline.item" }> =>
            e.type === "timeline.item" && e.item.type === "tool_call",
        )
        .map(
          (e) =>
            e.item as Extract<
              Extract<ProviderEvent, { type: "timeline.item" }>["item"],
              { type: "tool_call" }
            >,
        );
      expect(tools.find((t) => t.callId === "shell-1" && t.status === "completed")?.detail).toEqual(
        {
          type: "shell",
          command: "ls -la",
          output: "file.txt\n",
          exitCode: 0,
        },
      );
      expect(tools.find((t) => t.callId === "read-1")?.detail).toEqual({
        type: "read",
        filePath: "/repo/a.ts",
        content: "export const a = 1;",
        offset: 1,
        limit: 5,
      });
      expect(tools.find((t) => t.callId === "write-1")?.detail).toEqual({
        type: "write",
        filePath: "/repo/b.ts",
        content: "export const b = 2;\n",
      });
      expect(tools.find((t) => t.callId === "edit-1")?.detail).toEqual({
        type: "edit",
        filePath: "/repo/a.ts",
        oldString: "a = 1",
        newString: "a = 2",
      });

      await connection.send({
        type: "session.open",
        requestId: "open-legacy",
        sessionId: "s-legacy",
        history: "skip",
        persistence: { version: 1, data: { conversationId: "legacy-conv-1" } },
        config: { cwd, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "session.ready" }> =>
          e.type === "session.ready" && e.sessionId === "s-legacy",
        "open-legacy",
      );
      expect(
        readLog(logPath).some(
          (entry) =>
            entry.method === "session/resume" &&
            (entry.params as { sessionId?: string }).sessionId === "legacy-conv-1",
        ),
      ).toBe(true);
    } finally {
      await connection.close();
    }
  });
});
