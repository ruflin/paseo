import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const logFile = process.env.AGY_TEST_LOG;

function record(entry) {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

record({ args, pid: process.pid, envValue: process.env.AGY_SESSION_VALUE ?? null });

if (args.includes("--version")) {
  process.stdout.write(`${process.env.AGY_TEST_VERSION || "1.5.8"}\n`);
  process.exit(0);
}

if (process.env.AGY_TEST_STARTUP === "exit") {
  process.exit(3);
}

if (process.env.AGY_TEST_STARTUP === "stderr") {
  process.stderr.write("Error: authentication required. Run 'agy' to log in, then retry.\n");
  process.exit(1);
}

let nextRequestId = 1;
const pendingOutgoing = new Map();
let activeCancel = null;
let currentModel = "gemini-4-argon";
let currentThinking = "medium";
let currentMode = "default";
let currentSessionId = "acp-session-1";

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendNotify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function sendRequest(method, params) {
  const id = `srv-${nextRequestId++}`;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pendingOutgoing.set(id, resolve));
}

function buildConfigOptions() {
  const thinkingChoices = [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ];
  if (currentModel === "gemini-4-hydrogen") {
    thinkingChoices.push({ value: "xhigh", name: "Extra" });
  }
  if (!thinkingChoices.some((choice) => choice.value === currentThinking)) {
    currentThinking = "medium";
  }
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: [
        { value: "gemini-4-argon", name: "Gemini 4 Argon" },
        { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
      ],
    },
    {
      id: "thought_level",
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      currentValue: currentThinking,
      options: thinkingChoices,
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: currentMode,
      options: [
        { value: "default", name: "Default" },
        { value: "accept-edits", name: "Accept Edits" },
        { value: "auto", name: "Auto" },
        { value: "plan", name: "Plan" },
      ],
    },
  ];
}

function buildModes() {
  return {
    currentModeId: currentMode,
    availableModes: [
      { id: "default", name: "Default", description: "Ask before running tools" },
      { id: "accept-edits", name: "Accept Edits", description: "Auto-approve edits" },
      { id: "auto", name: "Auto", description: "Run without asking" },
      { id: "plan", name: "Plan", description: "Read-only planning" },
    ],
  };
}

function updateSession(update) {
  sendNotify("session/update", { sessionId: currentSessionId, update });
}

async function handlePrompt(id, params) {
  const promptBlocks = params.prompt || [];
  const text = promptBlocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const imageBlock = promptBlocks.find((b) => b.type === "image");

  updateSession({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });

  if (text.includes("HANG")) {
    updateSession({
      sessionUpdate: "tool_call",
      toolCallId: "hang-tool",
      name: "run_command",
      kind: "execute",
      status: "in_progress",
      rawInput: { CommandLine: "sleep 30" },
    });
    await new Promise((resolve) => {
      activeCancel = resolve;
    });
    activeCancel = null;
    send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
    return;
  }

  if (text.includes("PERMISSION")) {
    updateSession({
      sessionUpdate: "tool_call",
      toolCallId: "perm-tool-1",
      name: "run_command",
      kind: "execute",
      status: "pending",
      rawInput: { CommandLine: "echo secret" },
    });
    const reply = await sendRequest("session/request_permission", {
      sessionId: currentSessionId,
      toolCall: {
        toolCallId: "perm-tool-1",
        name: "run_command",
        kind: "execute",
        status: "pending",
        title: "Run echo secret",
        rawInput: { CommandLine: "echo secret" },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    const selected = reply.outcome?.optionId;
    updateSession({
      sessionUpdate: "tool_call_update",
      toolCallId: "perm-tool-1",
      status: selected === "allow" ? "completed" : "failed",
      rawOutput: {
        output: selected === "allow" ? "secret\n" : "Permission denied",
        exitCode: selected === "allow" ? 0 : 1,
      },
    });
    updateSession({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Permission outcome: ${selected ?? "cancelled"}` },
    });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  if (text.includes("TOOLS")) {
    updateSession({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Let me run tools." },
    });
    updateSession({
      sessionUpdate: "tool_call",
      toolCallId: "shell-1",
      name: "run_command",
      kind: "execute",
      status: "pending",
      rawInput: { CommandLine: "ls -la" },
    });
    updateSession({
      sessionUpdate: "tool_call_update",
      toolCallId: "shell-1",
      status: "completed",
      rawOutput: { output: "file.txt\n", exitCode: 0 },
    });
    updateSession({
      sessionUpdate: "tool_call",
      toolCallId: "read-1",
      name: "read_file",
      kind: "read",
      status: "completed",
      rawInput: { Path: "/repo/a.ts", StartLine: 1, EndLine: 5 },
      rawOutput: { content: "export const a = 1;" },
      locations: [{ path: "/repo/a.ts" }],
    });
    updateSession({
      sessionUpdate: "tool_call",
      toolCallId: "write-1",
      name: "write_file",
      kind: "edit",
      status: "completed",
      rawInput: { Path: "/repo/b.ts", Content: "export const b = 2;\n" },
      locations: [{ path: "/repo/b.ts" }],
      content: [{ type: "diff", path: "/repo/b.ts", newText: "export const b = 2;\n" }],
    });
    updateSession({
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      name: "edit_file",
      kind: "edit",
      status: "completed",
      rawInput: { Path: "/repo/a.ts", Target: "a = 1", Replacement: "a = 2" },
      locations: [{ path: "/repo/a.ts" }],
      content: [{ type: "diff", path: "/repo/a.ts", oldText: "a = 1", newText: "a = 2" }],
    });
    updateSession({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Tools complete." },
    });
    send({
      jsonrpc: "2.0",
      id,
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 120, outputTokens: 30, cachedReadTokens: 40 },
      },
    });
    return;
  }

  if (text.includes("PLAN")) {
    updateSession({
      sessionUpdate: "plan",
      entries: [
        { content: "Inspect codebase", status: "completed" },
        { content: "Implement fix", status: "in_progress" },
      ],
    });
    updateSession({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Planned." },
    });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  const reply = imageBlock
    ? `Got image ${imageBlock.mimeType} (${imageBlock.data.length})`
    : `Echo: ${text}`;
  updateSession({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: reply.slice(0, 4) },
  });
  updateSession({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: reply.slice(4) },
  });
  updateSession({ sessionUpdate: "usage_update", used: 512, size: 1048576 });
  send({
    jsonrpc: "2.0",
    id,
    result: {
      stopReason: "end_turn",
      usage: { inputTokens: 25, outputTokens: 10, cachedReadTokens: 5 },
    },
  });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  record({ method, params });

  if (method === "initialize") {
    if (process.env.AGY_TEST_STARTUP === "auth") {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Not signed in" } });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} },
          _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
        },
        agentInfo: { name: "Antigravity ACP Test Server", version: "1.5.8" },
      },
    });
    return;
  }

  if (method === "session/new") {
    currentSessionId = process.env.AGY_TEST_SESSION_ID || "acp-session-1";
    send({
      jsonrpc: "2.0",
      id,
      result: {
        sessionId: currentSessionId,
        modes: buildModes(),
        configOptions: buildConfigOptions(),
      },
    });
    setTimeout(() => {
      updateSession({
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "compact", description: "Compact conversation" },
          { name: "plan", description: "Create a plan", input: { hint: "goal" } },
        ],
      });
      updateSession({ sessionUpdate: "usage_update", used: 0, size: 1048576 });
    }, 10);
    return;
  }

  if (method === "session/resume") {
    currentSessionId = params.sessionId;
    send({
      jsonrpc: "2.0",
      id,
      result: { modes: buildModes(), configOptions: buildConfigOptions() },
    });
    setTimeout(() => {
      updateSession({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "compact", description: "Compact conversation" }],
      });
    }, 5);
    return;
  }

  if (method === "session/load") {
    currentSessionId = params.sessionId;
    updateSession({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "Earlier user prompt" },
    });
    updateSession({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Replayed thinking" },
    });
    updateSession({
      sessionUpdate: "tool_call",
      toolCallId: "replay-tool-1",
      name: "read_file",
      kind: "read",
      status: "completed",
      rawInput: { Path: "/repo/README.md" },
      rawOutput: { content: "Hello" },
      locations: [{ path: "/repo/README.md" }],
    });
    updateSession({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Earlier assistant reply" },
    });
    send({
      jsonrpc: "2.0",
      id,
      result: { modes: buildModes(), configOptions: buildConfigOptions() },
    });
    return;
  }

  if (method === "session/list") {
    const cwdA = process.env.AGY_TEST_LIST_CWD_A || "/repo-a";
    const cwdB = process.env.AGY_TEST_LIST_CWD_B || "/repo-b";
    send({
      jsonrpc: "2.0",
      id,
      result: {
        sessions: [
          {
            sessionId: "sess-a",
            cwd: cwdA,
            title: "Alpha task",
            updatedAt: "2026-11-14T10:00:00.000Z",
          },
          {
            sessionId: "sess-b",
            cwd: cwdB,
            title: "Beta task",
            updatedAt: "2026-11-14T11:00:00.000Z",
          },
          {
            sessionId: "sess-a2",
            cwd: cwdA,
            title: "Second repo A",
            updatedAt: "2026-11-14T12:00:00.000Z",
          },
        ],
      },
    });
    return;
  }

  if (method === "session/set_config_option") {
    if (params.configId === "model") currentModel = params.value;
    if (params.configId === "thought_level") currentThinking = params.value;
    if (params.configId === "mode") currentMode = params.value;
    send({
      jsonrpc: "2.0",
      id,
      result: { modes: buildModes(), configOptions: buildConfigOptions() },
    });
    return;
  }

  if (method === "session/set_mode") {
    currentMode = params.modeId;
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "session/close") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "session/prompt") {
    await handlePrompt(id, params);
    return;
  }

  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && ("result" in msg || "error" in msg)) {
    const resolve = pendingOutgoing.get(msg.id);
    if (resolve) {
      pendingOutgoing.delete(msg.id);
      resolve(msg.result);
    }
    return;
  }
  if (msg.method === "session/cancel") {
    record({ method: "session/cancel", params: msg.params });
    if (activeCancel) activeCancel();
    return;
  }
  if (msg.method) {
    void handleRequest(msg);
  }
});
