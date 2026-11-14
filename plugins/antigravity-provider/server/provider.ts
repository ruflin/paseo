import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type {
  ProviderMode,
  ProviderPersistence,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { getCatalogCacheKey, getStatus } from "./internal/catalog.js";
import { antigravityToolTransformer } from "./internal/tools.js";

function readLegacyConversationId(persistence: ProviderPersistence): string | null {
  if (
    typeof persistence.data !== "object" ||
    persistence.data === null ||
    Array.isArray(persistence.data)
  ) {
    return null;
  }
  const conversationId = (persistence.data as Record<string, unknown>).conversationId;
  return typeof conversationId === "string" && conversationId.length > 0 ? conversationId : null;
}

function markUnattendedMode(mode: ProviderMode): ProviderMode {
  const updated: ProviderMode = {
    id: mode.id,
    label: mode.label,
    isUnattended: mode.id === "auto" || mode.id === "full-access",
  };
  if (mode.description) updated.description = mode.description;
  if (mode.icon) updated.icon = mode.icon;
  if (mode.colorTier) updated.colorTier = mode.colorTier;
  return updated;
}

export function createAntigravityProvider(): ProviderRegistration {
  const acp = runAcpProvider({
    id: "antigravity",
    label: "Antigravity",
    description: "Run Antigravity via ACP",
    icon: "icon.svg",
    command: ["agy", "acp"],
    acpOptions: {
      waitForInitialCommands: true,
      initialCommandsTimeoutMs: 150,
      filterSessionsByCwd: true,
      discoverThinkingPerModel: true,
    },
    transformers: [
      {
        sessionMeta: (config) =>
          config.systemPrompt
            ? { antigravity: { systemPrompt: { append: config.systemPrompt } } }
            : undefined,
        readPersistenceSessionId: readLegacyConversationId,
        toolCall: antigravityToolTransformer,
        discover: (catalog) => ({
          ...catalog,
          modes: catalog.modes.map(markUnattendedMode),
        }),
      },
    ],
  });

  return {
    ...acp,
    status: getStatus,
    getCatalogCacheKey,
  };
}
