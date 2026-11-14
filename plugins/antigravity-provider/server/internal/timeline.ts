import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  ProviderPermissionAction,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import type { AcpPermissionOption, AcpPermissionRequestParams, AcpToolCallFields } from "./wire.js";

export type ToolCallTimelineItem = Extract<ProviderTimelineItem, { type: "tool_call" }>;

export interface ToolCallSnapshot {
  id: string;
  name?: string;
  title?: string;
  kind?: string;
  status: string;
  input: JsonValue;
  output: JsonValue;
  locations: string[];
  diff?: { path: string; oldText?: string | null; newText: string };
  contentText?: string;
}

function asJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return z.json().parse(value);
  } catch {
    return null;
  }
}

function asRecord(value: JsonValue): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value;
}

function firstString(...values: Array<unknown>): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function firstNumber(...values: Array<unknown>): number | undefined {
  return values.find((value): value is number => typeof value === "number");
}

function extractContent(
  current: ToolCallSnapshot | undefined,
  content: AcpToolCallFields["content"],
): Pick<ToolCallSnapshot, "diff" | "contentText"> {
  let diff = current?.diff;
  const textParts: string[] = [];
  for (const item of content ?? []) {
    if (item.type === "diff" && "newText" in item) {
      diff = { path: item.path, oldText: item.oldText ?? undefined, newText: item.newText };
    } else if (
      item.type === "content" &&
      "content" in item &&
      typeof item.content.text === "string"
    ) {
      textParts.push(item.content.text);
    }
  }
  return {
    diff,
    contentText: textParts.length > 0 ? textParts.join("\n") : current?.contentText,
  };
}

function pickJson(next: unknown, previous: JsonValue | undefined): JsonValue {
  if (next !== undefined) return asJsonValue(next);
  return previous ?? null;
}

export function reduceToolCall(
  current: ToolCallSnapshot | undefined,
  update: AcpToolCallFields,
): ToolCallSnapshot {
  const { diff, contentText } = extractContent(current, update.content);
  return {
    id: update.toolCallId,
    name: update.name ?? current?.name,
    title: update.title ?? current?.title,
    kind: update.kind ?? current?.kind,
    status: update.status ?? current?.status ?? "pending",
    input: pickJson(update.rawInput ?? update.args, current?.input),
    output: pickJson(update.rawOutput, current?.output),
    locations: update.locations
      ? update.locations.map((loc) => loc.path)
      : (current?.locations ?? []),
    diff,
    contentText,
  };
}

function shellDetail(
  snapshot: ToolCallSnapshot,
  input: Record<string, JsonValue>,
  output: Record<string, JsonValue>,
): ProviderToolCallDetail {
  const command = firstString(input.CommandLine, input.command, input.cmd, snapshot.title) ?? "";
  const cwd = firstString(input.Cwd, input.cwd);
  const shellOutput = firstString(
    output.output,
    output.stdout,
    output.Output,
    snapshot.contentText,
    typeof snapshot.output === "string" ? snapshot.output : undefined,
  );
  const exitCode = firstNumber(output.exitCode, output.exit_code);
  return {
    type: "shell",
    command,
    ...(cwd ? { cwd } : {}),
    ...(shellOutput !== undefined ? { output: shellOutput } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function readDetail(
  snapshot: ToolCallSnapshot,
  input: Record<string, JsonValue>,
  output: Record<string, JsonValue>,
): ProviderToolCallDetail {
  const filePath =
    firstString(input.Path, input.filePath, input.AbsolutePath, snapshot.locations[0]) ?? "";
  const content = firstString(
    output.content,
    output.text,
    snapshot.contentText,
    typeof snapshot.output === "string" ? snapshot.output : undefined,
  );
  const offset = firstNumber(input.StartLine, input.offset);
  const endLine = firstNumber(input.EndLine);
  const computedLimit =
    offset !== undefined && endLine !== undefined && endLine >= offset
      ? endLine - offset + 1
      : undefined;
  const limit = firstNumber(input.limit) ?? computedLimit;
  return {
    type: "read",
    filePath,
    ...(content !== undefined ? { content } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function writeDetail(
  snapshot: ToolCallSnapshot,
  input: Record<string, JsonValue>,
): ProviderToolCallDetail {
  const filePath =
    firstString(
      input.Path,
      input.filePath,
      input.TargetFile,
      snapshot.diff?.path,
      snapshot.locations[0],
    ) ?? "";
  const content = firstString(
    input.Content,
    input.CodeContent,
    input.content,
    snapshot.diff?.newText,
  );
  return { type: "write", filePath, ...(content !== undefined ? { content } : {}) };
}

function editDetail(
  snapshot: ToolCallSnapshot,
  input: Record<string, JsonValue>,
): ProviderToolCallDetail {
  const filePath =
    firstString(
      input.Path,
      input.filePath,
      input.TargetFile,
      snapshot.diff?.path,
      snapshot.locations[0],
    ) ?? "";
  const oldString = firstString(
    input.oldString,
    input.Target,
    input.TargetContent,
    snapshot.diff?.oldText ?? undefined,
  );
  const newString = firstString(
    input.newString,
    input.Replacement,
    input.ReplacementContent,
    snapshot.diff?.newText,
  );
  const unifiedDiff = firstString(input.unifiedDiff);
  return {
    type: "edit",
    filePath,
    ...(oldString !== undefined ? { oldString } : {}),
    ...(newString !== undefined ? { newString } : {}),
    ...(unifiedDiff !== undefined ? { unifiedDiff } : {}),
  };
}

function resolveSearchKind(toolName: string): "grep" | "glob" | "search" {
  if (toolName === "grep_search") return "grep";
  if (toolName === "find_by_name") return "glob";
  return "search";
}

function searchDetail(
  toolName: string,
  snapshot: ToolCallSnapshot,
  input: Record<string, JsonValue>,
  output: Record<string, JsonValue>,
): ProviderToolCallDetail {
  const query =
    firstString(input.Query, input.query, input.Pattern, input.pattern, snapshot.title) ?? "";
  const content = firstString(output.content, snapshot.contentText);
  return {
    type: "search",
    query,
    toolName: resolveSearchKind(toolName),
    ...(snapshot.locations.length > 0 ? { filePaths: snapshot.locations } : {}),
    ...(content !== undefined ? { content } : {}),
  };
}

const EDIT_TOOL_NAMES = new Set([
  "edit_file",
  "replace_file_content",
  "multi_replace_file_content",
]);

function isEditTool(snapshot: ToolCallSnapshot, toolName: string): boolean {
  return snapshot.kind === "edit" || EDIT_TOOL_NAMES.has(toolName) || toolName.includes("edit");
}

function isWriteDiff(snapshot: ToolCallSnapshot, input: Record<string, JsonValue>): boolean {
  const hasOldTarget = Boolean(firstString(input.Target, input.oldString, input.unifiedDiff));
  return (
    snapshot.kind === "edit" && Boolean(snapshot.diff) && !snapshot.diff?.oldText && !hasOldTarget
  );
}

export function extractToolDetail(snapshot: ToolCallSnapshot): ProviderToolCallDetail {
  const input = asRecord(snapshot.input);
  const output = asRecord(snapshot.output);
  const toolName = (snapshot.name ?? snapshot.title ?? "").toLowerCase();

  if (snapshot.kind === "execute" || toolName === "run_command" || toolName === "shell") {
    return shellDetail(snapshot, input, output);
  }
  if (snapshot.kind === "read" || toolName === "read_file" || toolName === "view_file") {
    return readDetail(snapshot, input, output);
  }
  if (toolName === "write_file" || toolName === "write_to_file" || isWriteDiff(snapshot, input)) {
    return writeDetail(snapshot, input);
  }
  if (isEditTool(snapshot, toolName)) {
    return editDetail(snapshot, input);
  }
  if (snapshot.kind === "search" || toolName === "grep_search" || toolName === "find_by_name") {
    return searchDetail(toolName, snapshot, input, output);
  }
  if (snapshot.kind === "fetch" || toolName === "read_url_content") {
    const url = firstString(input.Url, input.url, snapshot.title) ?? "";
    const result = firstString(output.content, snapshot.contentText);
    return { type: "fetch", url, ...(result !== undefined ? { result } : {}) };
  }
  return { type: "unknown", input: snapshot.input, output: snapshot.output };
}

function normalizeToolStatus(status: string): "running" | "canceled" | "failed" | "completed" {
  if (status === "pending" || status === "in_progress") return "running";
  if (status === "cancelled" || status === "canceled") return "canceled";
  if (status === "failed") return "failed";
  return "completed";
}

export function toToolTimelineItem(snapshot: ToolCallSnapshot): ToolCallTimelineItem {
  const detail = extractToolDetail(snapshot);
  const status = normalizeToolStatus(snapshot.status);
  const base = {
    type: "tool_call" as const,
    id: snapshot.id,
    callId: snapshot.id,
    name: snapshot.name ?? snapshot.title ?? "tool",
    detail,
  };
  if (status === "failed") {
    return {
      ...base,
      status: "failed",
      error: snapshot.output ?? { message: "Tool failed" },
    };
  }
  return { ...base, status, error: null };
}

function actionVariant(
  behavior: "allow" | "deny",
  kind: string,
): "primary" | "secondary" | "danger" {
  if (behavior === "deny") return "danger";
  return kind === "allow_once" ? "primary" : "secondary";
}

export function toPermissionRequest(
  permissionId: string,
  params: AcpPermissionRequestParams,
): ProviderPermissionRequest {
  const snapshot = reduceToolCall(undefined, params.toolCall);
  const detail = extractToolDetail(snapshot);
  const actions: ProviderPermissionAction[] = params.options.map((option) => {
    const behavior = isAllowKind(option.kind) ? "allow" : "deny";
    return {
      id: option.optionId,
      label: option.name,
      behavior,
      variant: actionVariant(behavior, option.kind),
    };
  });
  return {
    id: permissionId,
    name: params.toolCall.name ?? params.toolCall.title ?? "Permission",
    kind: "tool",
    title: params.toolCall.title ?? params.toolCall.name ?? "Permission required",
    input: asRecord(snapshot.input),
    detail,
    ...(actions.length > 0 ? { actions } : {}),
  };
}

export function selectPermissionOption(
  options: readonly AcpPermissionOption[],
  response: ProviderPermissionResponse,
): AcpPermissionOption | null {
  if (response.selectedActionId !== undefined) {
    const exact = options.find((option) => option.optionId === response.selectedActionId);
    if (!exact) return null;
    const expectedAllow = response.behavior === "allow";
    if (isAllowKind(exact.kind) !== expectedAllow) return null;
    return exact;
  }
  const preferredKinds =
    response.behavior === "allow"
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
  for (const kind of preferredKinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) return match;
  }
  return null;
}

function isAllowKind(kind: string): boolean {
  return kind === "allow_once" || kind === "allow_always";
}
