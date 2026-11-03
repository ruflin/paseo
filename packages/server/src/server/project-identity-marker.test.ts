import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { readProjectKeyMarker } from "./project-identity-marker.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) rmSync(target, { recursive: true, force: true });
});

function createRoot(paseoJson?: string | null): string {
  const root = mkdtempSync(path.join(tmpdir(), "project-identity-marker-"));
  cleanupPaths.push(root);
  if (paseoJson !== null && paseoJson !== undefined) {
    writeFileSync(path.join(root, "paseo.json"), paseoJson);
  }
  return root;
}

describe("readProjectKeyMarker", () => {
  test("reads project.key from paseo.json", async () => {
    const root = createRoot(JSON.stringify({ project: { key: "paseo-app" } }));

    await expect(readProjectKeyMarker(root)).resolves.toBe("paseo-app");
  });

  test("trims the declared key", async () => {
    const root = createRoot(JSON.stringify({ project: { key: "  paseo-app  " } }));

    await expect(readProjectKeyMarker(root)).resolves.toBe("paseo-app");
  });

  test("returns null without a paseo.json", async () => {
    await expect(readProjectKeyMarker(createRoot())).resolves.toBeNull();
  });

  test("returns null without a project block", async () => {
    const root = createRoot(JSON.stringify({ worktree: { setup: "npm ci" } }));

    await expect(readProjectKeyMarker(root)).resolves.toBeNull();
  });

  test("returns null for an invalid marker instead of failing the caller", async () => {
    const root = createRoot(JSON.stringify({ project: { key: "has space" } }));

    await expect(readProjectKeyMarker(root)).resolves.toBeNull();
  });

  test("returns null for malformed JSON", async () => {
    const root = createRoot("{ project: ");

    await expect(readProjectKeyMarker(root)).resolves.toBeNull();
  });

  test("returns null when the directory does not exist", async () => {
    await expect(
      readProjectKeyMarker(path.join(tmpdir(), "missing-identity-marker")),
    ).resolves.toBeNull();
  });

  test("ignores a marker in a parent directory", async () => {
    const root = createRoot(JSON.stringify({ project: { key: "paseo-app" } }));
    const nested = path.join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });

    await expect(readProjectKeyMarker(nested)).resolves.toBeNull();
  });
});
