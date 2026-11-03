import { readPaseoConfig } from "../utils/paseo-config-file.js";
import { normalizeProjectKeyMarker } from "./project-key.js";

/**
 * Reads the directory-declared project identity from `<rootPath>/paseo.json`.
 *
 * Only the exact project root is consulted, and only its working-tree copy: the
 * marker describes the directory the caller opened, not a committed ref or a
 * parent. Every failure mode (missing file, unreadable file, invalid JSON, no
 * `project.key`) means "no marker" so reconciliation keeps its previous
 * behaviour instead of failing.
 */
export async function readProjectKeyMarker(rootPath: string): Promise<string | null> {
  try {
    const result = await readPaseoConfig(rootPath);
    return result.ok ? normalizeProjectKeyMarker(result.config?.project?.key) : null;
  } catch {
    return null;
  }
}
