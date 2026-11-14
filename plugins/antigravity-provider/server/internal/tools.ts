import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { AcpToolCallSnapshot } from "@getpaseo/plugin/server/acp";
import type { ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value;
}

function firstString(...values: Array<unknown>): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function firstNumber(...values: Array<unknown>): number | undefined {
  return values.find((value): value is number => typeof value === "number");
}

function extractDiffAndContentText(content: JsonValue | undefined): {
  diff?: { path: string; oldText?: string; newText: string };
  contentText?: string;
} {
  if (!Array.isArray(content)) return {};
  let diff: { path: string; oldText?: string; newText: string } | undefined;
  const texts: string[] = [];
  for (const entry of content) {
    const record = asRecord(entry);
    if (record.type === "diff" && typeof record.newText === "string") {
      diff = {
        path: typeof record.path === "string" ? record.path : "",
        oldText: typeof record.oldText === "string" ? record.oldText : undefined,
        newText: record.newText,
      };
    } else if (record.type === "content") {
      const inner = asRecord(record.content);
      if (typeof inner.text === "string") texts.push(inner.text);
    }
  }
  return { diff, contentText: texts.length > 0 ? texts.join("\n") : undefined };
}

function shellDetail(
  snapshot: AcpToolCallSnapshot,
  input: Record<string, JsonValue>,
  output: Record<string, JsonValue>,
  contentText?: string,
): ProviderToolCallDetail {
  const command = firstString(input.CommandLine, input.command, input.cmd, snapshot.title) ?? "";
  const cwd = firstString(input.Cwd, input.cwd);
  const shellOutput = firstString(
    output.output,
    output.stdout,
    output.Output,
    contentText,
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
  snapshot: AcpToolCallSnapshot,
  input: Record<string, JsonValue>,
  output: Record<string, JsonValue>,
  contentText?: string,
): ProviderToolCallDetail {
  const filePath =
    firstString(input.Path, input.filePath, input.AbsolutePath, snapshot.locations[0]) ?? "";
  const content = firstString(
    output.content,
    output.text,
    contentText,
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
  snapshot: AcpToolCallSnapshot,
  input: Record<string, JsonValue>,
  diff?: { path: string; oldText?: string; newText: string },
): ProviderToolCallDetail {
  const filePath =
    firstString(input.Path, input.filePath, input.TargetFile, diff?.path, snapshot.locations[0]) ??
    "";
  const content = firstString(input.Content, input.CodeContent, input.content, diff?.newText);
  return { type: "write", filePath, ...(content !== undefined ? { content } : {}) };
}

function editDetail(
  snapshot: AcpToolCallSnapshot,
  input: Record<string, JsonValue>,
  diff?: { path: string; oldText?: string; newText: string },
): ProviderToolCallDetail {
  const filePath =
    firstString(input.Path, input.filePath, input.TargetFile, diff?.path, snapshot.locations[0]) ??
    "";
  const oldString = firstString(input.oldString, input.Target, input.TargetContent, diff?.oldText);
  const newString = firstString(
    input.newString,
    input.Replacement,
    input.ReplacementContent,
    diff?.newText,
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

const EDIT_TOOL_NAMES = new Set([
  "edit_file",
  "replace_file_content",
  "multi_replace_file_content",
]);

function searchKind(toolName: string): "grep" | "glob" | "search" {
  if (toolName === "grep_search") return "grep";
  if (toolName === "find_by_name") return "glob";
  return "search";
}

function searchDetail(
  toolName: string,
  snapshot: AcpToolCallSnapshot,
  input: Record<string, JsonValue>,
  output: Record<string, JsonValue>,
  contentText?: string,
): ProviderToolCallDetail {
  const query =
    firstString(input.Query, input.query, input.Pattern, input.pattern, snapshot.title) ?? "";
  const content = firstString(output.content, contentText);
  return {
    type: "search",
    query,
    toolName: searchKind(toolName),
    ...(snapshot.locations.length > 0 ? { filePaths: [...snapshot.locations] } : {}),
    ...(content !== undefined ? { content } : {}),
  };
}

function isWriteTool(
  snapshot: AcpToolCallSnapshot,
  toolName: string,
  input: Record<string, JsonValue>,
  diff: { path: string; oldText?: string; newText: string } | undefined,
): boolean {
  if (toolName === "write_file" || toolName === "write_to_file") return true;
  const hasOldTarget = Boolean(firstString(input.Target, input.oldString, input.unifiedDiff));
  return snapshot.kind === "edit" && Boolean(diff) && !diff?.oldText && !hasOldTarget;
}

function isEditTool(snapshot: AcpToolCallSnapshot, toolName: string): boolean {
  return snapshot.kind === "edit" || EDIT_TOOL_NAMES.has(toolName) || toolName.includes("edit");
}

function resolveDetail(
  snapshot: AcpToolCallSnapshot,
  input: Record<string, JsonValue>,
  output: Record<string, JsonValue>,
  diff: { path: string; oldText?: string; newText: string } | undefined,
  contentText: string | undefined,
): ProviderToolCallDetail | undefined {
  const toolName = (snapshot.name ?? snapshot.title ?? "").toLowerCase();
  if (snapshot.kind === "execute" || toolName === "run_command" || toolName === "shell") {
    return shellDetail(snapshot, input, output, contentText);
  }
  if (snapshot.kind === "read" || toolName === "read_file" || toolName === "view_file") {
    return readDetail(snapshot, input, output, contentText);
  }
  if (isWriteTool(snapshot, toolName, input, diff)) {
    return writeDetail(snapshot, input, diff);
  }
  if (isEditTool(snapshot, toolName)) {
    return editDetail(snapshot, input, diff);
  }
  if (snapshot.kind === "search" || toolName === "grep_search" || toolName === "find_by_name") {
    return searchDetail(toolName, snapshot, input, output, contentText);
  }
  if (snapshot.kind === "fetch" || toolName === "read_url_content") {
    const url = firstString(input.Url, input.url, snapshot.title) ?? "";
    const result = firstString(output.content, contentText);
    return { type: "fetch", url, ...(result !== undefined ? { result } : {}) };
  }
  return undefined;
}

export function antigravityToolTransformer(snapshot: AcpToolCallSnapshot): AcpToolCallSnapshot {
  const input = asRecord(snapshot.input);
  const output = asRecord(snapshot.output);
  const { diff, contentText } = extractDiffAndContentText(snapshot.content);
  const detail = resolveDetail(snapshot, input, output, diff, contentText);
  return detail ? { ...snapshot, detail } : snapshot;
}
