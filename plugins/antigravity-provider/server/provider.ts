import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { formatDiagnostic, getCatalogCacheKey, getStatus } from "./internal/catalog.js";
import { antigravityToolTransformer } from "./internal/tools.js";

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
        toolCall: antigravityToolTransformer,
        formatError: (error) =>
          formatDiagnostic(error instanceof Error ? error.message : String(error)),
        discover: (catalog) => ({
          ...catalog,
          modes: catalog.modes.map((mode) => ({
            ...mode,
            isUnattended: mode.id === "auto",
          })),
        }),
      },
    ],
  });

  return {
    ...acp,
    status: (request) => getStatus(request, acp.connect),
    getCatalogCacheKey,
  };
}
