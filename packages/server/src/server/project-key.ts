import { resolve, win32 } from "node:path";
import { isGitHubHost, parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { getRealpathAwareRelativePath, normalizePathForIdentity } from "../utils/path.js";

/** Persisted opaque key used to join the same remote across hosts. */
export function deriveProjectKey(input: {
  rootPath: string;
  remoteUrl: string | null;
  worktreeRoot: string | null;
  mainRepoRoot: string | null;
  serverId?: string;
  /** Normalized `project.key` marker from `paseo.json`, when the directory declares one. */
  projectKeyMarker?: string | null;
}): string {
  const selectedPath = input.worktreeRoot
    ? getRealpathAwareRelativePath(input.worktreeRoot, input.rootPath) || null
    : null;
  const subdirSuffix = selectedPath ? `#subdir:${selectedPath.replaceAll("\\", "/")}` : "";
  // Explicit directory-declared identity outranks Git and the filesystem: it is
  // the only way to group a checkout with a copy that has no remote at all.
  if (input.projectKeyMarker) {
    return `paseo:${input.projectKeyMarker}${subdirSuffix}`;
  }

  const remote = input.remoteUrl ? parseGitRemoteLocation(input.remoteUrl) : null;
  if (remote) {
    const host = remote.port ? `${remote.host}:${remote.port}` : remote.host;
    const path = isGitHubHost(remote.host) ? remote.path.toLowerCase() : remote.path;
    const remoteKey = `remote:${host}/${path}`;
    return selectedPath ? `${remoteKey}${subdirSuffix}` : remoteKey;
  }

  const localPathParts = [
    selectedPath && input.mainRepoRoot ? input.mainRepoRoot : input.rootPath,
    selectedPath && input.mainRepoRoot ? selectedPath : "",
  ];
  const resolvedLocalPath = localPathParts.some(looksLikeWindowsPath)
    ? win32.resolve(...localPathParts)
    : resolve(...localPathParts);
  const localPath = normalizePathForIdentity(resolvedLocalPath);
  return input.serverId ? `host:${input.serverId}:${localPath}` : localPath;
}

export function deriveProjectGroupingDisplayName(input: {
  rootPath: string;
  remoteUrl: string | null;
  worktreeRoot: string | null;
}): string {
  const selectedPath = input.worktreeRoot
    ? getRealpathAwareRelativePath(input.worktreeRoot, input.rootPath)
    : null;
  if (selectedPath) return lastPathSegment(input.rootPath);

  const remote = input.remoteUrl ? parseGitRemoteLocation(input.remoteUrl) : null;
  if (!remote) return lastPathSegment(input.rootPath);
  return remote.path.split("/").filter(Boolean).slice(-2).join("/") || input.rootPath;
}

function lastPathSegment(inputPath: string): string {
  const segments = inputPath.split(/[\\/]/u).filter(Boolean);
  return segments[segments.length - 1] ?? inputPath;
}

// Bounded, path- and separator-safe: a marker never contains `/` or `#`, so it
// cannot collide with the `remote:` namespace or the `#subdir:` suffix.
const PROJECT_KEY_MARKER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * The `project.key` marker from `paseo.json` is user-declared identity. Anything
 * that is not a bounded token is ignored instead of failing the caller.
 */
export function normalizeProjectKeyMarker(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return PROJECT_KEY_MARKER_PATTERN.test(trimmed) ? trimmed : null;
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(value) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/u.test(value);
}
