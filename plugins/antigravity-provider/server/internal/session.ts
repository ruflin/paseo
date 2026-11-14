import { randomUUID } from "node:crypto";
import type {
  ProviderCapability,
  ProviderConfigChanges,
  ProviderEvent,
  ProviderInput,
  ProviderLaunch,
  ProviderPersistence,
  ProviderPrompt,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import { type AcpClient, type AcpIncomingRequest, startAcpClient } from "./acp-client.js";
import { encodePrompt } from "./prompt.js";
import {
  reduceToolCall,
  selectPermissionOption,
  toPermissionRequest,
  toToolTimelineItem,
  type ToolCallSnapshot,
  type ToolCallTimelineItem,
} from "./timeline.js";
import {
  ACP_PROTOCOL_VERSION,
  AcpInitializeResultSchema,
  AcpPermissionRequestParamsSchema,
  AcpPromptResultSchema,
  AcpSessionMutateResultSchema,
  AcpSessionResultSchema,
  AcpSessionUpdateParamsSchema,
  AntigravityError,
  diagnostic,
  findModeOption,
  findModelOption,
  findThinkingOption,
  toAcpMcpServers,
  toProviderConfigState,
  type AcpConfigOption,
  type AcpInitializeResult,
  type AcpModes,
  type AcpPermissionRequestParams,
  type AcpSessionResult,
  type AcpSessionUpdate,
} from "./wire.js";

const OPEN_TIMEOUT_MS = 30_000;
const INITIAL_COMMANDS_WAIT_MS = 100;

interface PendingPermission {
  request: AcpPermissionRequestParams;
  incoming: AcpIncomingRequest;
}

interface TextSegmentTracker {
  kind: "user" | "assistant" | "thought" | null;
  id: string | null;
  buffer: string;
  counter: number;
}

interface ActiveTurn {
  id: string;
  settled: Promise<void>;
  tools: Map<string, ToolCallTimelineItem>;
  snapshots: Map<string, ToolCallSnapshot>;
  segments: TextSegmentTracker;
}

export interface SessionOptions {
  launch: ProviderLaunch;
  capabilities: readonly ProviderCapability[];
  emit(event: ProviderEvent): void;
  onTerminated(): void;
}

export function readPersistedSessionId(
  persistence: ProviderPersistence | undefined,
): string | null {
  if (
    !persistence ||
    typeof persistence.data !== "object" ||
    persistence.data === null ||
    Array.isArray(persistence.data)
  ) {
    return null;
  }
  const data = persistence.data as Record<string, unknown>;
  if (typeof data.sessionId === "string" && data.sessionId.length > 0) return data.sessionId;
  // Legacy persistence migration from stream-json Antigravity provider
  if (typeof data.conversationId === "string" && data.conversationId.length > 0) {
    return data.conversationId;
  }
  return null;
}

function createTracker(): TextSegmentTracker {
  return { kind: null, id: null, buffer: "", counter: 0 };
}

function resetTracker(tracker: TextSegmentTracker): void {
  tracker.kind = null;
  tracker.id = null;
  tracker.buffer = "";
}

function planToTodoItems(entries: Extract<AcpSessionUpdate, { sessionUpdate: "plan" }>["entries"]) {
  return entries.map((entry) => ({
    text: entry.content,
    completed: entry.status === "completed",
    status:
      entry.status === "completed" || entry.status === "in_progress"
        ? (entry.status as "completed" | "in_progress")
        : ("pending" as const),
  }));
}

export class AntigravitySession {
  private client: AcpClient | null = null;
  private initResult: AcpInitializeResult | null = null;
  private nativeSessionId: string | null = null;
  private modes: AcpModes | null = null;
  private configOptions: AcpConfigOption[] = [];
  private usage: ProviderUsage = {};
  private replayMode: "replay" | "skip" | null = null;
  private replayTracker = createTracker();
  private replaySnapshots = new Map<string, ToolCallSnapshot>();

  private activeTurn: ActiveTurn | null = null;
  private promptLane: Promise<void> = Promise.resolve();
  private notificationQueue: Promise<void> = Promise.resolve();
  private permissions = new Map<string, PendingPermission>();
  private closed = false;

  private commandsReceived = false;
  private commandsWaiter: (() => void) | null = null;

  constructor(
    private readonly boundarySessionId: string,
    private readonly options: SessionOptions,
  ) {}

  async open(input: Extract<ProviderInput, { type: "session.open" }>): Promise<void> {
    const client = startAcpClient({
      launch: this.options.launch,
      cwd: input.config.cwd,
      env: input.config.env,
      onNotification: (method, params) => {
        this.notificationQueue = this.notificationQueue.then(() =>
          this.handleNotification(method, params),
        );
      },
      onRequest: (incoming) => this.handleRequest(incoming),
      onExit: (error) => this.handleUnexpectedExit(error),
    });
    this.client = client;

    try {
      const init = AcpInitializeResultSchema.parse(
        await client.request(
          "initialize",
          { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} },
          OPEN_TIMEOUT_MS,
        ),
      );
      this.initResult = init;

      const result = await this.openOrResumeSession(client, init, input);
      this.modes = result.modes ?? null;
      this.configOptions = result.configOptions ?? [];

      await this.applyConfig({
        model: input.config.model,
        thinkingOption: input.config.thinkingOption,
        mode: input.config.mode,
      });

      this.emit({
        type: "session.opened",
        requestId: input.requestId,
        sessionId: this.boundarySessionId,
        capabilities: this.negotiateSessionCapabilities(init),
        restoration: "core",
        persistence: { version: 1, data: { sessionId: result.sessionId } },
        title: input.config.title,
        cwd: input.config.cwd,
      });
      this.publishConfig();
      await this.waitForInitialCommands();
      this.emit({
        type: "session.ready",
        requestId: input.requestId,
        sessionId: this.boundarySessionId,
      });
    } catch (error) {
      this.closed = true;
      this.options.onTerminated();
      await client.stop("close").catch(() => undefined);
      throw error instanceof AntigravityError
        ? error
        : new AntigravityError(error instanceof Error ? diagnostic(error.message) : String(error));
    }
  }

  private async openOrResumeSession(
    client: AcpClient,
    init: AcpInitializeResult,
    input: Extract<ProviderInput, { type: "session.open" }>,
  ): Promise<AcpSessionResult> {
    const mcpServers = toAcpMcpServers(input.config.mcpServers);
    const metaFields = input.config.systemPrompt
      ? { _meta: { antigravity: { systemPrompt: { append: input.config.systemPrompt } } } }
      : {};
    const resumeId = readPersistedSessionId(input.persistence);

    if (!resumeId) {
      const created = AcpSessionResultSchema.parse(
        await client.request(
          "session/new",
          { cwd: input.config.cwd, mcpServers, ...metaFields },
          OPEN_TIMEOUT_MS,
        ),
      );
      this.nativeSessionId = created.sessionId;
      return created;
    }

    this.nativeSessionId = resumeId;
    const canLoad = init.agentCapabilities?.loadSession === true;
    const canResume = init.agentCapabilities?.sessionCapabilities?.resume !== undefined;

    if (input.history === "replay" && canLoad) {
      return this.loadExistingSession(
        client,
        resumeId,
        input.config.cwd,
        mcpServers,
        metaFields,
        "replay",
      );
    }
    if (canResume) {
      const resumed = AcpSessionMutateResultSchema.parse(
        await client.request(
          "session/resume",
          { sessionId: resumeId, cwd: input.config.cwd, mcpServers, ...metaFields },
          OPEN_TIMEOUT_MS,
        ),
      );
      await this.drainNotifications();
      return { sessionId: resumeId, ...resumed };
    }
    if (canLoad) {
      return this.loadExistingSession(
        client,
        resumeId,
        input.config.cwd,
        mcpServers,
        metaFields,
        "skip",
      );
    }
    throw new AntigravityError(
      "Antigravity ACP agent does not support resuming sessions",
      "RESUME_UNSUPPORTED",
    );
  }

  private async loadExistingSession(
    client: AcpClient,
    sessionId: string,
    cwd: string,
    mcpServers: ReturnType<typeof toAcpMcpServers>,
    metaFields: Record<string, unknown>,
    replayMode: "replay" | "skip",
  ): Promise<AcpSessionResult> {
    this.replayMode = replayMode;
    try {
      const loaded = AcpSessionMutateResultSchema.parse(
        await client.request(
          "session/load",
          { sessionId, cwd, mcpServers, ...metaFields },
          OPEN_TIMEOUT_MS,
        ),
      );
      await this.drainNotifications();
      return { sessionId, ...loaded };
    } finally {
      this.replayMode = null;
    }
  }

  private negotiateSessionCapabilities(init: AcpInitializeResult): readonly ProviderCapability[] {
    const supportsImage = init.agentCapabilities?.promptCapabilities?.image !== false;
    const supportsConfigure = this.modes !== null || this.configOptions.length > 0;
    return this.options.capabilities.filter((cap) => {
      if (cap === "prompt.image" && !supportsImage) return false;
      if (cap === "session.configure" && !supportsConfigure) return false;
      return true;
    });
  }

  private handleUnexpectedExit(error: AntigravityError | null): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelAllPermissions();
    this.options.onTerminated();
    this.emit({
      type: "session.runtime_failed",
      sessionId: this.boundarySessionId,
      error: {
        message: error?.message ?? "Antigravity ACP process exited unexpectedly",
        ...(error?.code ? { code: error.code } : {}),
      },
    });
  }

  prompt(prompt: ProviderPrompt): Promise<void> {
    const admission = this.promptLane.then(() => this.runPrompt(prompt));
    this.promptLane = admission.catch(() => undefined);
    return admission;
  }

  private async runPrompt(prompt: ProviderPrompt): Promise<void> {
    if (this.closed || !this.client || !this.nativeSessionId) {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.boundarySessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "failed", error: { message: "Antigravity session is closed" } },
      });
      return;
    }

    if (this.activeTurn) {
      await this.interrupt();
      await this.activeTurn.settled;
    }
    if (prompt.clearPendingPermissions) {
      this.cancelAllPermissions();
    }

    const supportsImage = this.initResult?.agentCapabilities?.promptCapabilities?.image !== false;
    const { blocks, summaryText } = encodePrompt(prompt, { image: supportsImage });
    const turnId = `acp:${prompt.clientMessageId}`;

    const turn: ActiveTurn = {
      id: turnId,
      settled: Promise.resolve(),
      tools: new Map(),
      snapshots: new Map(),
      segments: createTracker(),
    };

    this.emit({
      type: "timeline.item",
      sessionId: this.boundarySessionId,
      item: {
        type: "user_message",
        id: prompt.clientMessageId,
        text: summaryText,
        clientMessageId: prompt.clientMessageId,
      },
    });
    this.emit({
      type: "session.prompt_result",
      sessionId: this.boundarySessionId,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
    this.emit({
      type: "session.turn",
      sessionId: this.boundarySessionId,
      turnId,
      state: "started",
    });

    const settled = this.client
      .request("session/prompt", { sessionId: this.nativeSessionId, prompt: blocks }, 0)
      .then(
        async (raw) => {
          await this.drainNotifications();
          this.completeTurn(turn, AcpPromptResultSchema.parse(raw));
          return undefined;
        },
        async (error) => {
          await this.drainNotifications();
          this.failTurn(turn, error);
          return undefined;
        },
      );

    turn.settled = settled;
    this.activeTurn = turn;
  }

  private completeTurn(
    turn: ActiveTurn,
    result: ReturnType<typeof AcpPromptResultSchema.parse>,
  ): void {
    if (result.usage) {
      this.usage = {
        ...this.usage,
        inputTokens: result.usage.inputTokens ?? this.usage.inputTokens,
        outputTokens: result.usage.outputTokens ?? this.usage.outputTokens,
        cachedInputTokens: result.usage.cachedReadTokens ?? this.usage.cachedInputTokens,
      };
      this.emit({
        type: "session.usage",
        sessionId: this.boundarySessionId,
        turnId: turn.id,
        usage: { ...this.usage },
      });
    }
    const state = result.stopReason === "cancelled" ? "canceled" : "completed";
    this.finishTurnTools(turn, state);
    if (this.activeTurn === turn) this.activeTurn = null;
    this.emit({
      type: "session.turn",
      sessionId: this.boundarySessionId,
      turnId: turn.id,
      state,
    });
  }

  private failTurn(turn: ActiveTurn, error: unknown): void {
    this.finishTurnTools(turn, "failed");
    if (this.activeTurn === turn) this.activeTurn = null;
    if (this.closed) return;
    this.emit({
      type: "session.turn",
      sessionId: this.boundarySessionId,
      turnId: turn.id,
      state: "failed",
      error: {
        message: error instanceof Error ? diagnostic(error.message) : String(error),
        ...(error instanceof AntigravityError && error.code ? { code: error.code } : {}),
      },
    });
  }

  async interrupt(): Promise<void> {
    if (this.closed || !this.client || !this.nativeSessionId) return;
    this.client.notify("session/cancel", { sessionId: this.nativeSessionId });
    this.cancelAllPermissions();
  }

  respondPermission(
    permissionId: string,
    response: Extract<ProviderInput, { type: "session.permission" }>["response"],
  ): void {
    const pending = this.permissions.get(permissionId);
    if (!pending) return;
    const selected = selectPermissionOption(pending.request.options, response);
    if (response.selectedActionId !== undefined && !selected) {
      throw new AntigravityError(
        `Invalid permission action '${response.selectedActionId}' for behavior '${response.behavior}'`,
        "INVALID_PERMISSION",
      );
    }
    this.permissions.delete(permissionId);
    pending.incoming.reply({
      outcome: selected
        ? { outcome: "selected", optionId: selected.optionId }
        : { outcome: "cancelled" },
    });
    this.emit({
      type: "session.permission_resolved",
      sessionId: this.boundarySessionId,
      permissionId,
    });
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    if (this.closed || !this.client || !this.nativeSessionId) {
      throw new AntigravityError("Antigravity session is closed", "SESSION_CLOSED");
    }
    await this.applyConfig({
      model: changes.model ?? undefined,
      thinkingOption: changes.thinkingOption ?? undefined,
      mode: changes.mode ?? undefined,
    });
    this.publishConfig();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelAllPermissions();
    this.options.onTerminated();
    const client = this.client;
    const sessionId = this.nativeSessionId;
    this.client = null;
    if (client) {
      if (
        sessionId &&
        this.initResult?.agentCapabilities?.sessionCapabilities?.close !== undefined
      ) {
        await client.request("session/close", { sessionId }, 2_000).catch(() => undefined);
      }
      await client.stop("close").catch(() => undefined);
    }
    this.emit({ type: "session.closed", sessionId: this.boundarySessionId });
  }

  private async setSelectOptionIfNeeded(
    option: AcpConfigOption | undefined,
    value: string | undefined,
  ): Promise<void> {
    if (value === undefined || !option || !this.client || !this.nativeSessionId) return;
    if (option.type === "select" && option.currentValue === value) return;
    const res = AcpSessionMutateResultSchema.parse(
      await this.client.request("session/set_config_option", {
        sessionId: this.nativeSessionId,
        configId: option.id,
        value,
      }),
    );
    if (res.configOptions) this.configOptions = res.configOptions;
    if (res.modes) this.modes = res.modes;
  }

  private async applyConfig(target: {
    model?: string;
    thinkingOption?: string;
    mode?: string;
  }): Promise<void> {
    if (!this.client || !this.nativeSessionId) return;
    await this.setSelectOptionIfNeeded(findModelOption(this.configOptions), target.model);
    await this.setSelectOptionIfNeeded(
      findThinkingOption(this.configOptions),
      target.thinkingOption,
    );
    if (target.mode === undefined) return;

    const modeOption = findModeOption(this.configOptions);
    if (modeOption) {
      await this.setSelectOptionIfNeeded(modeOption, target.mode);
      if (this.modes && this.modes.currentModeId !== target.mode) {
        this.modes = { ...this.modes, currentModeId: target.mode };
      }
      return;
    }
    if (this.modes && this.modes.currentModeId !== target.mode) {
      await this.client.request("session/set_mode", {
        sessionId: this.nativeSessionId,
        modeId: target.mode,
      });
      this.modes = { ...this.modes, currentModeId: target.mode };
    }
  }

  private handleRequest(incoming: AcpIncomingRequest): void {
    if (incoming.method !== "session/request_permission") {
      incoming.fail(-32601, `Method not found: ${incoming.method}`);
      return;
    }
    let parsed: AcpPermissionRequestParams;
    try {
      parsed = AcpPermissionRequestParamsSchema.parse(incoming.params);
    } catch (error) {
      incoming.fail(-32602, error instanceof Error ? error.message : String(error));
      return;
    }
    if (parsed.sessionId !== this.nativeSessionId) {
      incoming.reply({ outcome: { outcome: "cancelled" } });
      return;
    }
    const permissionId = `perm:${randomUUID()}`;
    this.permissions.set(permissionId, { request: parsed, incoming });
    this.emit({
      type: "session.permission",
      sessionId: this.boundarySessionId,
      request: toPermissionRequest(permissionId, parsed),
    });
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const parsed = AcpSessionUpdateParamsSchema.safeParse(params);
    if (!parsed.success || parsed.data.sessionId !== this.nativeSessionId) return;
    this.applyUpdate(parsed.data.update);
  }

  private applyMetadataUpdate(update: AcpSessionUpdate): boolean {
    if (update.sessionUpdate === "available_commands_update") {
      this.commandsReceived = true;
      this.commandsWaiter?.();
      this.commandsWaiter = null;
      this.emit({
        type: "session.commands",
        sessionId: this.boundarySessionId,
        commands: update.availableCommands.map((cmd) => ({
          name: cmd.name,
          description: cmd.description ?? "",
          ...(cmd.input?.hint ? { argumentHint: cmd.input.hint } : {}),
        })),
      });
      return true;
    }
    if (update.sessionUpdate === "config_option_update") {
      this.configOptions = update.configOptions;
      this.publishConfig();
      return true;
    }
    if (update.sessionUpdate === "current_mode_update") {
      if (this.modes) {
        this.modes = { ...this.modes, currentModeId: update.currentModeId };
        this.publishConfig();
      }
      return true;
    }
    if (update.sessionUpdate === "usage_update") {
      this.usage = {
        ...this.usage,
        contextWindowUsedTokens: update.used,
        contextWindowMaxTokens: update.size,
      };
      this.emit({
        type: "session.usage",
        sessionId: this.boundarySessionId,
        ...(this.activeTurn ? { turnId: this.activeTurn.id } : {}),
        usage: { ...this.usage },
      });
      return true;
    }
    return update.sessionUpdate === "session_info_update";
  }

  private applyUpdate(update: AcpSessionUpdate): void {
    if (this.applyMetadataUpdate(update)) return;
    if (this.replayMode === "skip") return;
    if (this.replayMode === "replay") {
      this.applyTimelineUpdate(update, "replay", this.replayTracker, this.replaySnapshots);
      return;
    }
    const turn = this.activeTurn;
    if (!turn || update.sessionUpdate === "user_message_chunk") return;
    this.applyTimelineUpdate(update, turn.id, turn.segments, turn.snapshots, turn.tools);
  }

  private emitChunkSegment(
    prefix: string,
    kind: "user" | "assistant" | "thought",
    delta: string,
    tracker: TextSegmentTracker,
  ): void {
    if (!delta) return;
    if (tracker.kind !== kind || !tracker.id) {
      tracker.kind = kind;
      tracker.counter += 1;
      tracker.id = `${prefix}:${kind}:${tracker.counter}`;
      tracker.buffer = "";
    }
    tracker.buffer += delta;
    if (kind === "user") {
      this.emit({
        type: "timeline.item",
        sessionId: this.boundarySessionId,
        item: { type: "user_message", id: tracker.id, text: tracker.buffer },
      });
      return;
    }
    if (kind === "thought") {
      this.emit({
        type: "timeline.item",
        sessionId: this.boundarySessionId,
        item: { type: "reasoning", id: tracker.id, text: tracker.buffer },
      });
      return;
    }
    this.emit({
      type: "timeline.item",
      sessionId: this.boundarySessionId,
      item: {
        type: "assistant_message",
        id: tracker.id,
        messageId: tracker.id,
        text: tracker.buffer,
      },
    });
  }

  private applyTimelineUpdate(
    update: AcpSessionUpdate,
    prefix: string,
    tracker: TextSegmentTracker,
    snapshots: Map<string, ToolCallSnapshot>,
    turnTools?: Map<string, ToolCallTimelineItem>,
  ): void {
    if (update.sessionUpdate === "user_message_chunk") {
      const delta = update.content.type === "text" ? (update.content.text ?? "") : "";
      this.emitChunkSegment(prefix, "user", delta, tracker);
      return;
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      const delta = update.content.type === "text" ? (update.content.text ?? "") : "";
      this.emitChunkSegment(prefix, "assistant", delta, tracker);
      return;
    }
    if (update.sessionUpdate === "agent_thought_chunk") {
      const delta = update.content.type === "text" ? (update.content.text ?? "") : "";
      this.emitChunkSegment(prefix, "thought", delta, tracker);
      return;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      resetTracker(tracker);
      const snapshot = reduceToolCall(snapshots.get(update.toolCallId), update);
      snapshots.set(update.toolCallId, snapshot);
      const item = toToolTimelineItem(snapshot);
      turnTools?.set(update.toolCallId, item);
      this.emit({ type: "timeline.item", sessionId: this.boundarySessionId, item });
      return;
    }
    if (update.sessionUpdate === "plan") {
      resetTracker(tracker);
      tracker.counter += 1;
      this.emit({
        type: "timeline.item",
        sessionId: this.boundarySessionId,
        item: {
          type: "todo",
          id: `${prefix}:plan:${tracker.counter}`,
          items: planToTodoItems(update.entries),
        },
      });
    }
  }

  private finishTurnTools(turn: ActiveTurn, state: "completed" | "canceled" | "failed"): void {
    for (const item of turn.tools.values()) {
      if (item.status !== "running") continue;
      this.emit({
        type: "timeline.item",
        sessionId: this.boundarySessionId,
        item:
          state === "failed"
            ? { ...item, status: "failed", error: { message: "Antigravity turn failed" } }
            : { ...item, status: state, error: null },
      });
    }
  }

  private cancelAllPermissions(): void {
    for (const [permissionId, entry] of this.permissions) {
      entry.incoming.reply({ outcome: { outcome: "cancelled" } });
      this.emit({
        type: "session.permission_resolved",
        sessionId: this.boundarySessionId,
        permissionId,
      });
    }
    this.permissions.clear();
  }

  private async drainNotifications(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await this.notificationQueue;
  }

  private async waitForInitialCommands(): Promise<void> {
    if (this.commandsReceived) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.commandsWaiter = null;
        resolve();
      };
      const timer = setTimeout(done, INITIAL_COMMANDS_WAIT_MS);
      this.commandsWaiter = () => {
        clearTimeout(timer);
        done();
      };
    });
  }

  private publishConfig(): void {
    this.emit({
      type: "session.config",
      sessionId: this.boundarySessionId,
      config: toProviderConfigState(this.modes, this.configOptions),
    });
  }

  private emit(event: ProviderEvent): void {
    this.options.emit(event);
  }
}
