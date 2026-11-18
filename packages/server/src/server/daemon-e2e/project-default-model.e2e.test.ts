import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { type PersistedProjectRecord } from "../workspace-registry.js";

const cleanupPaths = new Set<string>();
const cleanupDaemons = new Set<TestPaseoDaemon>();
const cleanupClients = new Set<DaemonClient>();

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}

afterEach(async () => {
  await Promise.all(Array.from(cleanupClients, (client) => client.close().catch(() => undefined)));
  cleanupClients.clear();
  await Promise.all(Array.from(cleanupDaemons, (daemon) => daemon.close().catch(() => undefined)));
  cleanupDaemons.clear();
  await Promise.all(
    Array.from(cleanupPaths, (target) => rm(target, { recursive: true, force: true })),
  );
  cleanupPaths.clear();
});

test("per-project default model persists across daemon restart and applies to agents created without an explicit model", async () => {
  const previousSupervised = process.env.PASEO_SUPERVISED;
  process.env.PASEO_SUPERVISED = "0";
  try {
    const repoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-default-model-repo-")));
    const paseoHomeRoot = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "paseo-default-model-home-")),
    );
    cleanupPaths.add(repoRoot);
    cleanupPaths.add(paseoHomeRoot);

    execSync("git init -b main", { cwd: repoRoot, stdio: "pipe" });
    execSync("git config user.email 'test@getpaseo.dev'", { cwd: repoRoot, stdio: "pipe" });
    execSync("git config user.name 'Paseo Test'", { cwd: repoRoot, stdio: "pipe" });
    writeFileSync(path.join(repoRoot, "README.md"), "# repo\n", "utf8");
    execSync("git add README.md", { cwd: repoRoot, stdio: "pipe" });
    execSync("git -c commit.gpgSign=false commit -m 'initial'", { cwd: repoRoot, stdio: "pipe" });

    const daemon = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
    cleanupDaemons.add(daemon);
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    cleanupClients.add(client);
    await client.connect();

    const created = await client.createWorkspace({ source: { kind: "directory", path: repoRoot } });
    expect(created.error).toBeNull();
    const workspaceId = created.workspace!.id;
    const projectId = created.workspace!.projectId;

    const setResult = await client.setProjectDefaultModel(projectId, {
      provider: "claude",
      model: "sonnet",
    });
    expect(setResult).toEqual({
      defaultModel: { provider: "claude", model: "sonnet" },
    });

    const projectsPath = path.join(daemon.paseoHome, "projects", "projects.json");
    const persisted = JSON.parse(await readFile(projectsPath, "utf8")) as PersistedProjectRecord[];
    expect(persisted.find((project) => project.projectId === projectId)?.defaultModel).toEqual({
      provider: "claude",
      model: "sonnet",
    });

    // Restart the daemon against the same PASEO_HOME and verify the default model survives
    // and is exposed on both project listings and workspace descriptors.
    await client.close();
    cleanupClients.delete(client);
    await daemon.close();
    cleanupDaemons.delete(daemon);

    const restarted = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
    cleanupDaemons.add(restarted);
    const restartedClient = new DaemonClient({ url: `ws://127.0.0.1:${restarted.port}/ws` });
    cleanupClients.add(restartedClient);
    await restartedClient.connect();

    const projectsResponse = await restartedClient.listProjects();
    expect(projectsResponse.projects.find((p) => p.projectId === projectId)?.defaultModel).toEqual({
      provider: "claude",
      model: "sonnet",
    });

    const workspacesResponse = await restartedClient.fetchWorkspaces();
    expect(
      workspacesResponse.entries.find((w) => w.id === workspaceId)?.projectDefaultModel,
    ).toEqual({
      provider: "claude",
      model: "sonnet",
    });

    // Creating an agent in that workspace without an explicit model uses the project's default.
    const agent = await restartedClient.createAgent({
      workspaceId,
      config: { provider: "claude", cwd: repoRoot },
    });
    expect(agent.model).toBe("sonnet");

    // Clearing the project default reverts it to null.
    const cleared = await restartedClient.setProjectDefaultModel(projectId, null);
    expect(cleared).toEqual({ defaultModel: null });
    const projectsAfterClear = await restartedClient.listProjects();
    expect(
      projectsAfterClear.projects.find((p) => p.projectId === projectId)?.defaultModel,
    ).toBeUndefined();
  } finally {
    restoreEnv("PASEO_SUPERVISED", previousSupervised);
  }
}, 45_000);
