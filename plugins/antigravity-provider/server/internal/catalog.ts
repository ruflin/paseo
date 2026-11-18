import { createHash } from "node:crypto";
import { execCommand } from "@getpaseo/plugin/server";
import type {
  ProviderCatalogOptions,
  ProviderLaunch,
  ProviderRegistration,
  ProviderStatus,
  ProviderStatusRequest,
} from "@getpaseo/plugin/server/provider";

const MIN_AGY_VERSION = "1.5.0";
const STATUS_TIMEOUT_MS = 10_000;
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

export function defaultLaunch(launch?: ProviderLaunch): ProviderLaunch {
  if (launch) return launch;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { command: "agy", args: ["acp"], env };
}

export function formatDiagnostic(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("not signed in") || lower.includes("authentication required")) {
    return `${message}\nRun 'agy' to sign in, or set an API key.`;
  }
  return message;
}

export async function getCatalogCacheKey(options: ProviderCatalogOptions): Promise<string> {
  const launch = defaultLaunch(options.launch);
  const envEntries: Array<[string, string]> = [];
  for (const key of RELEVANT_ENV_KEYS) {
    if (launch.env[key]) envEntries.push([key, launch.env[key]]);
  }
  for (const [key, value] of Object.entries(launch.env).sort(([a], [b]) => a.localeCompare(b))) {
    if (key.startsWith("AGY_")) envEntries.push([key, value]);
  }
  return createHash("sha256")
    .update(JSON.stringify([launch.command, launch.args, envEntries]))
    .digest("hex");
}

export async function getStatus(
  request: ProviderStatusRequest,
  connect: ProviderRegistration["connect"],
): Promise<ProviderStatus> {
  const launch = defaultLaunch(request.launch);
  let version: string;
  try {
    version = await probeVersion(launch);
  } catch (error) {
    return { available: false, diagnostic: formatDiagnostic(extractErrorText(error)) };
  }
  if (!isVersionAtLeast(version, MIN_AGY_VERSION)) {
    return {
      available: false,
      diagnostic: `Antigravity CLI ${MIN_AGY_VERSION} or newer is required for ACP support (found ${version || "unknown"}). Update Antigravity CLI to use this provider.`,
    };
  }
  let connection: Awaited<ReturnType<ProviderRegistration["connect"]>> | null = null;
  try {
    connection = await connect({ versions: [1], capabilities: [], launch });
    return { available: true };
  } catch (error) {
    return { available: false, diagnostic: formatDiagnostic(extractErrorText(error)) };
  } finally {
    await connection?.close().catch(() => undefined);
  }
}

async function probeVersion(launch: ProviderLaunch): Promise<string> {
  const baseArgs =
    launch.args[launch.args.length - 1] === "acp" ? launch.args.slice(0, -1) : launch.args;
  const { stdout } = await execCommand(launch.command, [...baseArgs, "--version"], {
    env: launch.env,
    timeout: STATUS_TIMEOUT_MS,
    maxBuffer: 64_000,
  });
  return stdout.trim();
}

function extractErrorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim().length > 0) return stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function isVersionAtLeast(actual: string, minimum: string): boolean {
  const parse = (raw: string): [number, number, number] | null => {
    const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = parse(actual);
  const b = parse(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}
