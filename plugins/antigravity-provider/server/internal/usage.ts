import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  execCommand,
  type UsageReport,
  type UsageSourceRegistration,
} from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromReportedDuration,
} from "@getpaseo/plugin/server/usage";
import { defaultLaunch, formatDiagnostic } from "./catalog.js";

const FIVE_HOURS_SECONDS = 5 * 3600;
const WEEKLY_SECONDS = 7 * 86_400;
const USAGE_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 15 * 60_000;
const LOG_CHUNK_BYTES = 64 * 1024;
const MAX_USAGE_BUFFER = 1024 * 1024;
const AUTH_EMAIL_PATTERN =
  /(?:applyAuthResult:\s*email=|OAuth:\s*authenticated successfully as\s+)([^\s,]+)(?=[,\s])/g;

const inputSchema = z.object({ dataDir: z.string().min(1) }).strict();

const usageJsonSchema = z.object({
  command: z.object({
    data: z.object({
      groups: z.array(
        z.object({
          name: z.string().min(1),
          buckets: z.array(
            z.object({
              id: z.string().optional(),
              name: z.string().optional(),
              window: z.string(),
              remaining_fraction: z.number().finite().nullish(),
              reset_time: z.string().nullish(),
            }),
          ),
        }),
      ),
    }),
  }),
});

interface ParsedBucket {
  id: string;
  name: string;
  window: string;
  remainingFraction?: number;
  resetTime?: string;
}

interface ParsedGroup {
  name: string;
  buckets: ParsedBucket[];
}

export function resolveAgyDataDir(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env.AGY_HOME?.trim();
  if (configured) return path.resolve(configured);
  const home = env.HOME?.trim() || homedir();
  return path.join(home, ".gemini", "antigravity-cli");
}

function stripAcpArg(args: readonly string[]): string[] {
  return args[args.length - 1] === "acp" ? args.slice(0, -1) : [...args];
}

function groupScopeLabel(name: string): string {
  if (name === "Gemini Models") return "Gemini";
  if (name === "Claude and GPT models") return "Claude / GPT";
  return name;
}

function windowOrder(window: string): number {
  if (window === "5h") return 0;
  if (window === "weekly") return 1;
  return 2;
}

function normalizeWindowName(bucketName: string): string {
  const lower = bucketName.toLowerCase();
  if (lower.includes("five hour") || lower.includes("5h")) return "5h";
  if (lower.includes("weekly")) return "weekly";
  return lower;
}

function durationSecondsForWindow(window: string): number | null {
  if (window === "5h") return FIVE_HOURS_SECONDS;
  if (window === "weekly") return WEEKLY_SECONDS;
  return null;
}

function parseUsageTsv(raw: string): ParsedGroup[] {
  const groups = new Map<string, ParsedBucket[]>();
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.split("\t").map((part) => part.trim());
    if (parts.length < 3) continue;
    const [groupName, bucketName, remainingRaw, resetTime] = parts;
    const pctMatch = remainingRaw?.match(/(\d+(?:\.\d+)?)\s*%/);
    if (!groupName || !bucketName || !pctMatch) continue;
    const remainingFraction = Number(pctMatch[1]) / 100;
    const window = normalizeWindowName(bucketName);
    const list = groups.get(groupName) ?? [];
    list.push({
      id: window,
      name: bucketName,
      window,
      remainingFraction,
      ...(resetTime ? { resetTime } : {}),
    });
    groups.set(groupName, list);
  }
  return [...groups.entries()].map(([name, buckets]) => ({ name, buckets }));
}

export function parseAgyUsageOutput(stdout: string): ParsedGroup[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = usageJsonSchema.parse(JSON.parse(trimmed));
    return parsed.command.data.groups.map((group) => ({
      name: group.name,
      buckets: group.buckets.map((bucket) => ({
        id: bucket.id ?? bucket.window,
        name: bucket.name ?? bucket.window,
        window: bucket.window,
        remainingFraction: bucket.remaining_fraction ?? undefined,
        resetTime: bucket.reset_time ?? undefined,
      })),
    }));
  } catch {
    return parseUsageTsv(trimmed);
  }
}

function toUsageReport(groups: readonly ParsedGroup[]): UsageReport {
  const windows = groups.flatMap((group) =>
    group.buckets
      .toSorted((left, right) => windowOrder(left.window) - windowOrder(right.window))
      .map((bucket) => {
        const usedPct =
          bucket.remainingFraction === undefined
            ? null
            : Math.round(Math.max(0, Math.min(1, 1 - bucket.remainingFraction)) * 100);
        return windowFromReportedDuration({
          durationSeconds: durationSecondsForWindow(bucket.window),
          scope: {
            id: group.name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "_")
              .replace(/^_|_$/g, ""),
            label: groupScopeLabel(group.name),
          },
          unknown: {
            id: bucket.id,
            label: bucket.name,
            shortLabel: bucket.name,
          },
          utilizationPct: usedPct,
          resetsAt: bucket.resetTime || null,
          summary: bucket.window === "5h",
          tone: toneFromUsedPct(usedPct),
        });
      }),
  );
  if (windows.length === 0) {
    return unavailable({ kind: "no_quota", detail: "No usage quota reported" });
  }
  return { status: "available", windows };
}

function isContained(target: string, base: string): boolean {
  const prefix = base === path.sep ? path.sep : `${base}${path.sep}`;
  return target.startsWith(prefix);
}

async function readEmailFromLogFile(filePath: string): Promise<string | undefined> {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0) return undefined;
    const readWindow = async (offset: number, length: number): Promise<string | undefined> => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const matches = [...buffer.toString("utf8", 0, bytesRead).matchAll(AUTH_EMAIL_PATTERN)];
      return matches.at(-1)?.[1];
    };
    const tailLen = Math.min(info.size, LOG_CHUNK_BYTES);
    const tail = await readWindow(info.size - tailLen, tailLen);
    if (tail) return tail;
    if (info.size > LOG_CHUNK_BYTES) {
      return await readWindow(0, LOG_CHUNK_BYTES);
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

async function readLoggedEmail(dataDir: string): Promise<string | undefined> {
  let base: string;
  try {
    if (!(await lstat(dataDir)).isDirectory()) return undefined;
    base = await realpath(dataDir);
  } catch {
    return undefined;
  }
  const logDir = path.join(base, "log");
  let names: string[] = [];
  try {
    if ((await lstat(logDir)).isDirectory()) {
      names = (await readdir(logDir)).filter((name) => /^(?:cli|acp-server)-.*\.log$/.test(name));
    }
  } catch {
    // Log directory is optional.
  }
  const candidates = await Promise.all(
    names.map(async (name) => {
      const candidate = path.join(logDir, name);
      const modified = await lstat(candidate).then(
        (stat) => (stat.isFile() ? stat.mtimeMs : 0),
        () => 0,
      );
      return { path: candidate, modified };
    }),
  );
  const ordered = candidates
    .filter((entry) => entry.modified > 0)
    .toSorted((left, right) => right.modified - left.modified)
    .slice(0, 5);
  for (const entry of ordered) {
    try {
      const resolved = await realpath(entry.path);
      if (!isContained(resolved, base)) continue;
      const email = await readEmailFromLogFile(resolved);
      if (email) return email;
    } catch {
      // Ignore unreadable logs.
    }
  }
  return undefined;
}

async function hasDataDirectory(dataDir: string): Promise<boolean> {
  return lstat(dataDir).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
}

export class AntigravityUsage {
  private readonly launches = new Map<string, ProviderLaunch>();
  private readonly cache = new Map<string, { at: number; report: UsageReport }>();
  private readonly inFlight = new Map<string, Promise<UsageReport>>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options?: { now?: () => number; ttlMs?: number }) {
    this.now = options?.now ?? Date.now;
    this.ttlMs = options?.ttlMs ?? CACHE_TTL_MS;
  }

  remember(launch?: ProviderLaunch): string | undefined {
    if (!launch) return undefined;
    const dataDir = resolveAgyDataDir(launch.env);
    this.launches.set(dataDir, launch);
    return dataDir;
  }

  private async runFetch(dataDir: string): Promise<UsageReport> {
    const cached = this.cache.get(dataDir);
    if (cached && this.now() - cached.at < this.ttlMs) {
      return cached.report;
    }
    const existing = this.inFlight.get(dataDir);
    if (existing) return existing;

    const task = (async (): Promise<UsageReport> => {
      const launch = defaultLaunch(this.launches.get(dataDir));
      try {
        const { stdout } = await execCommand(
          launch.command,
          [...stripAcpArg(launch.args), "-p", "/usage", "--output-format", "json"],
          {
            env: launch.env,
            timeout: USAGE_TIMEOUT_MS,
            maxBuffer: MAX_USAGE_BUFFER,
          },
        );
        const report = toUsageReport(parseAgyUsageOutput(stdout));
        if (report.status === "available") {
          this.cache.set(dataDir, { at: this.now(), report });
        }
        return report;
      } catch (error) {
        const message = extractCliError(error);
        const lower = message.toLowerCase();
        if (lower.includes("not signed in") || lower.includes("authentication required")) {
          return unavailable({ kind: "no_quota", detail: formatDiagnostic(message) });
        }
        return { status: "error", error: formatDiagnostic(message) };
      }
    })().finally(() => {
      this.inFlight.delete(dataDir);
    });

    this.inFlight.set(dataDir, task);
    return task;
  }

  registration(): UsageSourceRegistration {
    return {
      id: "antigravity",
      label: "Antigravity",
      icon: "icon.svg",
      input: inputSchema,
      discover: async (scope) => {
        const dirs = new Set<string>();
        if (scope.kind === "global") {
          for (const dir of this.launches.keys()) dirs.add(dir);
          dirs.add(resolveAgyDataDir(process.env));
        } else {
          if (scope.provider !== "antigravity") return [];
          dirs.add(resolveAgyDataDir(scope.env));
        }

        const accounts = [];
        for (const dataDir of dirs) {
          const known = this.launches.has(dataDir);
          if (!known && !(await hasDataDirectory(dataDir))) continue;
          const email = await readLoggedEmail(dataDir);
          accounts.push({
            key: hashAccountKey(dataDir),
            label: email ?? "Antigravity",
            harness: "Antigravity",
            input: { dataDir },
          });
        }
        return accounts;
      },
      fetch: async (rawInput) => {
        const { dataDir } = inputSchema.parse(rawInput);
        return this.runFetch(dataDir);
      },
    };
  }
}

function extractCliError(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim().length > 0) return stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}
