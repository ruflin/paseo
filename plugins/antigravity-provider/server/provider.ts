import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { formatDiagnostic, getCatalogCacheKey, getStatus } from "./internal/catalog.js";
import { antigravityToolTransformer } from "./internal/tools.js";
import type { AntigravityUsage } from "./internal/usage.js";

const PASEO_SUBAGENT_GUIDANCE =
  "When spawning subagents inside Paseo, use Paseo's `create_agent` MCP tool instead of `invoke_subagent` so subagents stay visible and controllable in Paseo.";

function buildSystemPromptAppend(
  systemPrompt: string | undefined,
  hasPaseoMcp: boolean,
): string | undefined {
  const parts = [systemPrompt?.trim() ?? "", hasPaseoMcp ? PASEO_SUBAGENT_GUIDANCE : ""].filter(
    (part) => part.length > 0,
  );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function createAntigravityProvider(usage?: AntigravityUsage): ProviderRegistration {
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
      steer: true,
    },
    transformers: [
      {
        sessionMeta: (config) => {
          const append = buildSystemPromptAppend(
            config.systemPrompt,
            Boolean(config.mcpServers.paseo),
          );
          return append ? { antigravity: { systemPrompt: { append } } } : undefined;
        },
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
    status: (request) => {
      usage?.remember(request.launch);
      return getStatus(request, acp.connect);
    },
    getCatalogCacheKey: (options) => {
      usage?.remember(options.launch);
      return getCatalogCacheKey(options);
    },
    connect: (request) => {
      usage?.remember(request.launch);
      return acp.connect(request);
    },
  };
}
