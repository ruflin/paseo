import { homedir } from "node:os";
import type {
  ProviderCatalog,
  ProviderCatalogOptions,
  ProviderLaunch,
  ProviderStatus,
  ProviderStatusRequest,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import { defaultLaunch, isVersionAtLeast, probeVersion, startAcpClient } from "./acp-client.js";
import {
  ACP_PROTOCOL_VERSION,
  AcpInitializeResultSchema,
  AcpSessionMutateResultSchema,
  AcpSessionResultSchema,
  AntigravityError,
  diagnostic,
  extractThinkingOptions,
  findModelOption,
  MIN_AGY_VERSION,
  selectChoices,
  toProviderCatalog,
  type AcpConfigOption,
} from "./wire.js";

const RELEVANT_ENV_KEYS = [
  "HOME",
  "PATH",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "ANTIGRAVITY_API_KEY",
  "AGY_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

export async function getCatalogCacheKey(options: ProviderCatalogOptions): Promise<string> {
  const launch = defaultLaunch(options.launch);
  const envEntries: Array<[string, string]> = [];
  for (const key of RELEVANT_ENV_KEYS) {
    if (launch.env[key]) envEntries.push([key, launch.env[key]]);
  }
  for (const [key, value] of Object.entries(launch.env).sort(([a], [b]) => a.localeCompare(b))) {
    if (key.startsWith("AGY_")) envEntries.push([key, value]);
  }
  return JSON.stringify({
    scope: options.scope,
    cwd: options.scope === "workspace" ? options.cwd : null,
    command: launch.command,
    args: launch.args,
    env: envEntries,
  });
}

export async function getStatus(request: ProviderStatusRequest): Promise<ProviderStatus> {
  const launch = defaultLaunch(request.launch);
  let version: string;
  try {
    version = await probeVersion(launch);
  } catch (error) {
    return {
      available: false,
      diagnostic: error instanceof Error ? error.message : diagnostic(String(error)),
    };
  }
  if (!isVersionAtLeast(version, MIN_AGY_VERSION)) {
    return {
      available: false,
      diagnostic: `Antigravity CLI ${MIN_AGY_VERSION} or newer is required for ACP support (found ${version || "unknown"}). Update Antigravity CLI to use this provider.`,
    };
  }
  const client = startAcpClient({ launch, cwd: homedir() });
  try {
    const raw = await client.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    AcpInitializeResultSchema.parse(raw);
    return { available: true };
  } catch (error) {
    return {
      available: false,
      diagnostic: error instanceof Error ? error.message : diagnostic(String(error)),
    };
  } finally {
    await client.stop("close").catch(() => undefined);
  }
}

export async function getCatalog(launch: ProviderLaunch, cwd?: string): Promise<ProviderCatalog> {
  const client = startAcpClient({ launch, cwd: cwd ?? homedir() });
  let probeSessionId: string | null = null;
  try {
    AcpInitializeResultSchema.parse(
      await client.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
    );
    const session = AcpSessionResultSchema.parse(
      await client.request("session/new", {
        cwd: cwd ?? homedir(),
        mcpServers: [],
      }),
    );
    probeSessionId = session.sessionId;
    const options: AcpConfigOption[] = session.configOptions ?? [];
    const thinkingByModel = await probeThinkingByModel(client, session.sessionId, options);

    return toProviderCatalog(session.modes, options, thinkingByModel);
  } catch (error) {
    if (error instanceof AntigravityError) throw error;
    throw new AntigravityError(
      error instanceof Error ? diagnostic(error.message) : diagnostic(String(error)),
      "CATALOG_ERROR",
    );
  } finally {
    if (probeSessionId) {
      await client
        .request("session/close", { sessionId: probeSessionId }, 3_000)
        .catch(() => undefined);
    }
    await client.stop("close").catch(() => undefined);
  }
}

async function probeThinkingByModel(
  client: ReturnType<typeof startAcpClient>,
  sessionId: string,
  options: readonly AcpConfigOption[],
): Promise<Map<string, { options: ProviderThinkingOption[]; defaultId?: string }>> {
  const thinkingByModel = new Map<
    string,
    { options: ProviderThinkingOption[]; defaultId?: string }
  >();
  const modelOpt = findModelOption(options);
  if (!modelOpt || modelOpt.type !== "select") return thinkingByModel;

  const initialThinking = extractThinkingOptions(options);
  if (initialThinking.options.length > 0) {
    thinkingByModel.set(modelOpt.currentValue, initialThinking);
  }
  for (const choice of selectChoices(modelOpt)) {
    if (choice.value === modelOpt.currentValue) continue;
    try {
      const mutated = AcpSessionMutateResultSchema.parse(
        await client.request("session/set_config_option", {
          sessionId,
          configId: modelOpt.id,
          value: choice.value,
        }),
      );
      if (!mutated.configOptions) continue;
      const perModel = extractThinkingOptions(mutated.configOptions);
      if (perModel.options.length > 0) thinkingByModel.set(choice.value, perModel);
    } catch {
      // Leave model without model-specific thinking overrides if probing fails.
    }
  }
  return thinkingByModel;
}
