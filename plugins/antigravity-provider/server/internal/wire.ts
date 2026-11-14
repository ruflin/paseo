import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  ProviderCatalog,
  ProviderConfigState,
  ProviderMcpServerConfig,
  ProviderMode,
  ProviderModel,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";

export const ACP_PROTOCOL_VERSION = 1 as const;
export const MIN_AGY_VERSION = "1.5.0";

export class AntigravityError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AntigravityError";
  }
}

export function diagnostic(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("not signed in") || lower.includes("authentication required")) {
    return `${message}\nRun 'agy' to sign in, or set an API key.`;
  }
  return message;
}

const ConfigSelectChoiceSchema = z.object({
  value: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
});

const ConfigSelectGroupSchema = z.object({
  group: z.string(),
  name: z.string().optional(),
  options: z.array(ConfigSelectChoiceSchema),
});

export const AcpConfigOptionSchema = z.union([
  z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    type: z.literal("select"),
    currentValue: z.string(),
    options: z.array(z.union([ConfigSelectChoiceSchema, ConfigSelectGroupSchema])),
  }),
  z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    type: z.literal("boolean"),
    currentValue: z.boolean(),
  }),
]);
export type AcpConfigOption = z.infer<typeof AcpConfigOptionSchema>;

export const AcpModesSchema = z.object({
  currentModeId: z.string(),
  availableModes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable().optional(),
    }),
  ),
});
export type AcpModes = z.infer<typeof AcpModesSchema>;

export const AcpInitializeResultSchema = z.object({
  protocolVersion: z.number(),
  agentCapabilities: z
    .object({
      loadSession: z.boolean().optional(),
      promptCapabilities: z
        .object({
          image: z.boolean().optional(),
          audio: z.boolean().optional(),
          embeddedContext: z.boolean().optional(),
        })
        .optional(),
      sessionCapabilities: z
        .object({
          list: z.unknown().optional(),
          load: z.unknown().optional(),
          resume: z.unknown().optional(),
          close: z.unknown().optional(),
        })
        .optional(),
    })
    .optional(),
  agentInfo: z
    .object({
      name: z.string(),
      version: z.string().optional(),
    })
    .optional(),
});
export type AcpInitializeResult = z.infer<typeof AcpInitializeResultSchema>;

export const AcpSessionResultSchema = z.object({
  sessionId: z.string().min(1),
  modes: AcpModesSchema.nullable().optional(),
  configOptions: z.array(AcpConfigOptionSchema).nullable().optional(),
});
export type AcpSessionResult = z.infer<typeof AcpSessionResultSchema>;

export const AcpSessionMutateResultSchema = z.object({
  modes: AcpModesSchema.nullable().optional(),
  configOptions: z.array(AcpConfigOptionSchema).nullable().optional(),
});
export type AcpSessionMutateResult = z.infer<typeof AcpSessionMutateResultSchema>;

export const AcpSessionListResultSchema = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      cwd: z.string(),
      title: z.string().nullable().optional(),
      updatedAt: z.string().nullable().optional(),
    }),
  ),
});
export type AcpSessionListResult = z.infer<typeof AcpSessionListResultSchema>;

export const AcpUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cachedReadTokens: z.number().nullable().optional(),
  cachedWriteTokens: z.number().nullable().optional(),
  thoughtTokens: z.number().nullable().optional(),
  totalTokens: z.number().optional(),
});

export const AcpPromptResultSchema = z.object({
  stopReason: z.string(),
  usage: AcpUsageSchema.nullable().optional(),
});
export type AcpPromptResult = z.infer<typeof AcpPromptResultSchema>;

export const AcpToolCallContentSchema = z.union([
  z.object({
    type: z.literal("content"),
    content: z.object({
      type: z.string(),
      text: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("diff"),
    path: z.string(),
    oldText: z.string().nullable().optional(),
    newText: z.string(),
  }),
  z.object({
    type: z.string(),
  }),
]);

export const AcpToolCallFieldsSchema = z.object({
  toolCallId: z.string(),
  title: z.string().optional(),
  name: z.string().optional(),
  kind: z.string().optional(),
  status: z.string().optional(),
  rawInput: z.unknown().optional(),
  args: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  locations: z
    .array(z.object({ path: z.string(), line: z.number().nullable().optional() }))
    .optional(),
  content: z.array(AcpToolCallContentSchema).optional(),
});
export type AcpToolCallFields = z.infer<typeof AcpToolCallFieldsSchema>;

export const AcpPermissionOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: z.string(),
});
export type AcpPermissionOption = z.infer<typeof AcpPermissionOptionSchema>;

export const AcpPermissionRequestParamsSchema = z.object({
  sessionId: z.string(),
  toolCall: AcpToolCallFieldsSchema,
  options: z.array(AcpPermissionOptionSchema),
});
export type AcpPermissionRequestParams = z.infer<typeof AcpPermissionRequestParamsSchema>;

export const AcpSessionUpdateParamsSchema = z.object({
  sessionId: z.string(),
  update: z.discriminatedUnion("sessionUpdate", [
    z.object({
      sessionUpdate: z.literal("agent_message_chunk"),
      msgId: z.string().nullable().optional(),
      content: z.object({ type: z.string(), text: z.string().optional() }),
    }),
    z.object({
      sessionUpdate: z.literal("agent_thought_chunk"),
      msgId: z.string().nullable().optional(),
      content: z.object({ type: z.string(), text: z.string().optional() }),
    }),
    z.object({
      sessionUpdate: z.literal("user_message_chunk"),
      content: z.object({ type: z.string(), text: z.string().optional() }),
    }),
    AcpToolCallFieldsSchema.extend({ sessionUpdate: z.literal("tool_call") }),
    AcpToolCallFieldsSchema.extend({ sessionUpdate: z.literal("tool_call_update") }),
    z.object({
      sessionUpdate: z.literal("plan"),
      entries: z.array(
        z.object({
          content: z.string(),
          priority: z.string().optional(),
          status: z.string(),
        }),
      ),
    }),
    z.object({
      sessionUpdate: z.literal("available_commands_update"),
      availableCommands: z.array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          input: z.object({ hint: z.string().optional() }).nullable().optional(),
        }),
      ),
    }),
    z.object({
      sessionUpdate: z.literal("current_mode_update"),
      currentModeId: z.string(),
    }),
    z.object({
      sessionUpdate: z.literal("config_option_update"),
      configOptions: z.array(AcpConfigOptionSchema),
    }),
    z.object({
      sessionUpdate: z.literal("session_info_update"),
      title: z.string().nullable().optional(),
      updatedAt: z.string().nullable().optional(),
    }),
    z.object({
      sessionUpdate: z.literal("usage_update"),
      used: z.number(),
      size: z.number(),
    }),
  ]),
});
export type AcpSessionUpdate = z.infer<typeof AcpSessionUpdateParamsSchema>["update"];

export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export function toAcpMcpServers(
  mcpServers: Readonly<Record<string, ProviderMcpServerConfig>>,
): Array<Record<string, JsonValue>> {
  return Object.entries(mcpServers).map(([name, server]): Record<string, JsonValue> => {
    if (server.type === "stdio") {
      return {
        name,
        command: server.command,
        args: server.args ?? [],
        env: Object.entries(server.env ?? {}).map(([key, value]) => ({ name: key, value })),
      };
    }
    return {
      type: server.type,
      name,
      url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({ name: key, value })),
    };
  });
}

export function selectChoices(
  option: AcpConfigOption | undefined,
): Array<{ value: string; label: string; description?: string }> {
  if (!option || option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "group" in entry
      ? entry.options.map((nested) => ({
          value: nested.value,
          label: nested.name,
          description: nested.description ?? undefined,
        }))
      : [{ value: entry.value, label: entry.name, description: entry.description ?? undefined }],
  );
}

export function findModelOption(options: readonly AcpConfigOption[]): AcpConfigOption | undefined {
  const candidates = options.filter((option) => option.category === "model");
  return candidates.find((option) => option.id === "model") ?? candidates[0];
}

export function findThinkingOption(
  options: readonly AcpConfigOption[],
): AcpConfigOption | undefined {
  return options.find((option) => option.category === "thought_level");
}

export function findModeOption(options: readonly AcpConfigOption[]): AcpConfigOption | undefined {
  return options.find((option) => option.category === "mode");
}

export function extractThinkingOptions(options: readonly AcpConfigOption[]): {
  options: ProviderThinkingOption[];
  defaultId?: string;
} {
  const option = findThinkingOption(options);
  if (!option || option.type !== "select") return { options: [] };
  const mapped: ProviderThinkingOption[] = selectChoices(option).map((choice) => {
    const entry: ProviderThinkingOption = { id: choice.value, label: choice.label };
    if (choice.description) entry.description = choice.description;
    if (choice.value === option.currentValue) entry.isDefault = true;
    return entry;
  });
  return { options: mapped, defaultId: option.currentValue };
}

export function toProviderModes(
  modes: AcpModes | null | undefined,
  options: readonly AcpConfigOption[],
): { modes: ProviderMode[]; currentModeId?: string } {
  if (modes) {
    return {
      currentModeId: modes.currentModeId,
      modes: modes.availableModes.map((mode) => {
        const entry: ProviderMode = {
          id: mode.id,
          label: mode.name,
          isUnattended: mode.id === "auto" || mode.id === "full-access",
        };
        if (mode.description) entry.description = mode.description;
        return entry;
      }),
    };
  }
  const modeOption = findModeOption(options);
  if (!modeOption || modeOption.type !== "select") return { modes: [] };
  return {
    currentModeId: modeOption.currentValue,
    modes: selectChoices(modeOption).map((choice) => {
      const entry: ProviderMode = {
        id: choice.value,
        label: choice.label,
        isUnattended: choice.value === "auto" || choice.value === "full-access",
      };
      if (choice.description) entry.description = choice.description;
      return entry;
    }),
  };
}

export function toProviderConfigState(
  modes: AcpModes | null | undefined,
  options: readonly AcpConfigOption[],
): ProviderConfigState {
  const modelOpt = findModelOption(options);
  const thinking = extractThinkingOptions(options);
  const resolvedModes = toProviderModes(modes, options);
  const currentModel = modelOpt && modelOpt.type === "select" ? modelOpt.currentValue : undefined;
  const models: ProviderModel[] = selectChoices(modelOpt).map((choice) => {
    const entry: ProviderModel = { id: choice.value, label: choice.label };
    if (choice.description) entry.description = choice.description;
    return entry;
  });
  return {
    model: currentModel,
    mode: resolvedModes.currentModeId,
    thinkingOption: thinking.defaultId,
    models,
    modes: resolvedModes.modes,
    thinkingOptions: thinking.options,
    settings: [],
  };
}

export function toProviderCatalog(
  modes: AcpModes | null | undefined,
  options: readonly AcpConfigOption[],
  thinkingByModel?: ReadonlyMap<string, { options: ProviderThinkingOption[]; defaultId?: string }>,
): ProviderCatalog {
  const state = toProviderConfigState(modes, options);
  const models: ProviderModel[] = state.models.map((model) => {
    const entry: ProviderModel = { id: model.id, label: model.label };
    if (model.description) entry.description = model.description;
    if (model.id === state.model) entry.isDefault = true;
    const perModel = thinkingByModel?.get(model.id);
    if (perModel && perModel.options.length > 0) {
      entry.thinkingOptions = perModel.options;
      entry.defaultThinkingOptionId = perModel.defaultId;
    }
    return entry;
  });
  return {
    models,
    modes: state.modes,
    thinkingOptions: state.thinkingOptions,
    defaultModel: state.model,
    defaultMode: state.mode,
    defaultThinkingOption: state.thinkingOption,
  };
}
