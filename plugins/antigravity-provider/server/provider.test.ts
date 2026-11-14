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

function tempDir(prefix = "paseo-agy-acp-test-"): string {
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

describe("antigravity-provider (ACP plugin-only)", () => {
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

  it("discovers catalog including per-model thinking options and closes probe session", async () => {
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
      const autoMode = ev.catalog.modes.find((m) => m.id === "auto");
      expect(autoMode?.isUnattended).toBe(true);

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

      await connection.send({
        type: "sessions",
        requestId: "list-2",
        cwd: cwdA,
        query: "Second",
        limit: 1,
      });
      const ev2 = await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "sessions" }> =>
          e.type === "sessions" && e.requestId === "list-2",
        "list-2",
      );
      expect(ev2.sessions).toHaveLength(1);
      expect(ev2.sessions[0]?.title).toBe("Second repo A");
    } finally {
      await connection.close();
    }
  });

  it("opens session with systemPrompt metadata, MCP servers, commands, streaming text, images, commands, and usage", async () => {
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
        | { params: { _meta?: unknown; mcpServers?: unknown } }
        | undefined;
      expect(newCall?.params._meta).toEqual({
        antigravity: { systemPrompt: { append: "Be concise." } },
      });
      expect(newCall?.params.mcpServers).toEqual([
        {
          type: "http",
          name: "paseo",
          url: "http://127.0.0.1:9999/mcp",
          headers: [{ name: "Authorization", value: "Bearer tok" }],
        },
      ]);

      await connection.send({
        type: "session.prompt",
        sessionId: "s-1",
        prompt: {
          clientMessageId: "msg-1",
          delivery: "auto",
          input: {
            type: "message",
            content: [
              { type: "text", text: "Hello ACP" },
              { type: "image", data: "QUJD", mimeType: "image/png" },
            ],
          },
        },
      });

      await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
          e.type === "session.turn" && e.state === "completed",
      );

      const userMessages = events.filter(
        (e) => e.type === "timeline.item" && e.item.type === "user_message",
      );
      expect(userMessages).toHaveLength(1);

      const assistantMessages = events.filter(
        (e): e is Extract<ProviderEvent, { type: "timeline.item" }> =>
          e.type === "timeline.item" && e.item.type === "assistant_message",
      );
      expect(assistantMessages.at(-1)?.item).toMatchObject({
        type: "assistant_message",
        text: "Got image image/png (4)",
      });

      const usage = events
        .toReversed()
        .find(
          (e): e is Extract<ProviderEvent, { type: "session.usage" }> => e.type === "session.usage",
        );
      expect(usage?.usage).toMatchObject({
        inputTokens: 25,
        outputTokens: 10,
        cachedInputTokens: 5,
        contextWindowUsedTokens: 512,
        contextWindowMaxTokens: 1048576,
      });

      await connection.send({
        type: "session.prompt",
        sessionId: "s-1",
        prompt: {
          clientMessageId: "cmd-1",
          delivery: "auto",
          input: { type: "command", name: "compact", arguments: "focus on tests" },
        },
      });
      await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
          e.type === "session.turn" && e.turnId === "acp:cmd-1" && e.state === "completed",
      );
      const lastAssistant = events
        .toReversed()
        .find(
          (e): e is Extract<ProviderEvent, { type: "timeline.item" }> =>
            e.type === "timeline.item" && e.item.type === "assistant_message",
        );
      expect(lastAssistant?.item).toMatchObject({ text: "Echo: /compact focus on tests" });
    } finally {
      await connection.close();
    }
  });

  it("maps shell, read, write, edit tools and plan items cleanly", async () => {
    const cwd = tempDir();
    const { connection, events } = await openHarness();
    try {
      await connection.send({
        type: "session.open",
        requestId: "open-tools",
        sessionId: "s-tools",
        history: "skip",
        config: { cwd, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "session.ready" }> => e.type === "session.ready",
        "open-tools",
      );

      await connection.send({
        type: "session.prompt",
        sessionId: "s-tools",
        prompt: {
          clientMessageId: "t-1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "TOOLS" }] },
        },
      });
      await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
          e.type === "session.turn" && e.turnId === "acp:t-1" && e.state === "completed",
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
    } finally {
      await connection.close();
    }
  });

  it("handles interactive permissions, live config switching, and turn interruption", async () => {
    const cwd = tempDir();
    const { connection, events } = await openHarness();
    try {
      await connection.send({
        type: "session.open",
        requestId: "open-p",
        sessionId: "s-p",
        history: "skip",
        config: { cwd, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "session.ready" }> => e.type === "session.ready",
        "open-p",
      );

      await connection.send({
        type: "session.configure",
        requestId: "cfg-1",
        sessionId: "s-p",
        changes: { model: "gemini-4-hydrogen", thinkingOption: "xhigh", mode: "auto" },
      });
      await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "request.completed" }> =>
          e.type === "request.completed" && e.requestId === "cfg-1",
        "cfg-1",
      );
      const latestConfig = events
        .toReversed()
        .find(
          (e): e is Extract<ProviderEvent, { type: "session.config" }> =>
            e.type === "session.config",
        );
      expect(latestConfig?.config.model).toBe("gemini-4-hydrogen");
      expect(latestConfig?.config.thinkingOption).toBe("xhigh");
      expect(latestConfig?.config.mode).toBe("auto");
      expect(latestConfig?.config.thinkingOptions.map((o) => o.id)).toContain("xhigh");

      await connection.send({
        type: "session.prompt",
        sessionId: "s-p",
        prompt: {
          clientMessageId: "perm-1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "PERMISSION" }] },
        },
      });
      const permReq = await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "session.permission" }> =>
          e.type === "session.permission",
      );
      expect(permReq.request.detail).toEqual({ type: "shell", command: "echo secret" });
      await connection.send({
        type: "session.permission",
        sessionId: "s-p",
        permissionId: permReq.request.id,
        response: { behavior: "allow", selectedActionId: "allow" },
      });
      await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
          e.type === "session.turn" && e.turnId === "acp:perm-1" && e.state === "completed",
      );

      await connection.send({
        type: "session.prompt",
        sessionId: "s-p",
        prompt: {
          clientMessageId: "hang-1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "HANG" }] },
        },
      });
      await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "timeline.item" }> =>
          e.type === "timeline.item" &&
          e.item.type === "tool_call" &&
          e.item.callId === "hang-tool",
      );
      await connection.send({
        type: "session.interrupt",
        requestId: "int-1",
        sessionId: "s-p",
      });
      await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "session.turn" }> =>
          e.type === "session.turn" && e.turnId === "acp:hang-1" && e.state === "canceled",
      );
      const canceledTool = events
        .toReversed()
        .find(
          (e): e is Extract<ProviderEvent, { type: "timeline.item" }> =>
            e.type === "timeline.item" &&
            e.item.type === "tool_call" &&
            e.item.callId === "hang-tool",
        );
      expect(canceledTool?.item).toMatchObject({ status: "canceled", error: null });
    } finally {
      await connection.close();
    }
  });

  it("resumes legacy conversationId via session/resume on skip and replays history via session/load on replay", async () => {
    const logPath = tempLog();
    const cwd = tempDir();
    const { connection, events } = await openHarness({ AGY_TEST_LOG: logPath });
    try {
      await connection.send({
        type: "session.open",
        requestId: "open-legacy",
        sessionId: "s-legacy",
        history: "skip",
        persistence: { version: 1, data: { conversationId: "legacy-conv-1" } },
        config: { cwd, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      const opened = await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "session.opened" }> =>
          e.type === "session.opened" && e.sessionId === "s-legacy",
        "open-legacy",
      );
      expect(opened.persistence).toEqual({ version: 1, data: { sessionId: "legacy-conv-1" } });
      await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "session.ready" }> =>
          e.type === "session.ready" && e.sessionId === "s-legacy",
      );

      await connection.send({
        type: "session.open",
        requestId: "open-replay",
        sessionId: "s-replay",
        history: "replay",
        persistence: { version: 1, data: { sessionId: "acp-prev-1" } },
        config: { cwd, env: {}, mcpServers: {}, settings: {}, persist: true },
      });
      await waitFor(
        events,
        (e): e is Extract<ProviderEvent, { type: "session.ready" }> =>
          e.type === "session.ready" && e.sessionId === "s-replay",
        "open-replay",
      );

      const replayed = events
        .filter(
          (e): e is Extract<ProviderEvent, { type: "timeline.item" }> =>
            e.type === "timeline.item" && e.sessionId === "s-replay",
        )
        .map((e) => e.item.type);
      expect(replayed).toEqual(["user_message", "reasoning", "tool_call", "assistant_message"]);

      const log = readLog(logPath);
      expect(log.some((entry) => entry.method === "session/resume")).toBe(true);
      expect(log.some((entry) => entry.method === "session/load")).toBe(true);
    } finally {
      await connection.close();
    }
  });
});
