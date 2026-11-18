import { expect, test, type Page } from "../support/fixtures";
import { seedModelProvider } from "../support/helpers/agent-profiles";
import { chooseModel, expectRememberedModel } from "../support/helpers/model-memory";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
} from "../support/helpers/new-workspace";
import { openProjectSettings, openProjects } from "../support/helpers/project-settings";
import { seedWorkspace } from "../support/helpers/seed-client";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { waitForDraftComposer } from "../support/helpers/command-center-agent-controls";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const PROVIDER = "project-default-model-e2e";
const MODEL_ID = "project-special-model";
const MODEL_LABEL = "Project Special Model";

async function selectCustomProjectDefaultModel(page: Page): Promise<void> {
  const section = page.getByTestId("project-default-model-section");
  await expect(section).toBeVisible({ timeout: 30_000 });
  await section.getByRole("button", { name: "Custom", exact: true }).click();
  await chooseModel(page, PROVIDER, MODEL_LABEL);
  await expect(page.getByTestId("app-toast-message")).toHaveText("Default model updated", {
    timeout: 15_000,
  });
}

async function resetProjectDefaultModelToGlobal(page: Page): Promise<void> {
  const section = page.getByTestId("project-default-model-section");
  await expect(section).toBeVisible({ timeout: 30_000 });
  await section.getByRole("button", { name: "Global default", exact: true }).click();
  await expect(page.getByTestId("app-toast-message")).toHaveText("Default model updated", {
    timeout: 15_000,
  });
}

test("project default model applies in New Workspace and new agent tabs without overriding other projects", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const projectA = await seedWorkspace({ repoPrefix: "proj-default-a-" });
  const projectB = await seedWorkspace({ repoPrefix: "proj-default-b-" });
  const provider = await seedModelProvider({
    id: PROVIDER,
    label: "Project Default E2E",
    extends: "claude",
    command: ["node"],
    models: [{ id: MODEL_ID, label: MODEL_LABEL, description: "Per-project default model" }],
  });

  try {
    // 1. Configure Project A's default model in Project Settings.
    await openProjects(page);
    await openProjectSettings(page, projectA.projectDisplayName);
    await selectCustomProjectDefaultModel(page);

    // 2. Return to the workspace shell, open New Workspace, and verify switching projects
    // switches between Project A's configured default model and Project B's global default.
    await gotoWorkspace(page, projectA.workspaceId);
    await waitForSidebarHydration(page);
    await openGlobalNewWorkspaceComposer(page);
    await selectNewWorkspaceProject(page, {
      projectKey: projectA.projectKey,
      projectDisplayName: projectA.projectDisplayName,
    });
    await expectRememberedModel(page, MODEL_LABEL);

    await selectNewWorkspaceProject(page, {
      projectKey: projectB.projectKey,
      projectDisplayName: projectB.projectDisplayName,
    });
    await expect(
      page
        .getByRole("button", { name: `Select model (${MODEL_LABEL})`, exact: true })
        .filter({ visible: true }),
    ).toHaveCount(0);

    await selectNewWorkspaceProject(page, {
      projectKey: projectA.projectKey,
      projectDisplayName: projectA.projectDisplayName,
    });
    await expectRememberedModel(page, MODEL_LABEL);

    // 3. Open a new agent draft tab inside Project A's workspace and verify it uses Project A's default.
    await gotoWorkspace(page, projectA.workspaceId);
    await waitForSidebarHydration(page);
    await runWorkspaceActionFromCommandCenter(page, "New agent");
    await waitForDraftComposer(page);
    await expectRememberedModel(page, MODEL_LABEL);

    // 4. Reset Project A back to Global default and verify New Workspace follows.
    await openProjects(page);
    await openProjectSettings(page, projectA.projectDisplayName);
    await resetProjectDefaultModelToGlobal(page);

    await gotoWorkspace(page, projectA.workspaceId);
    await waitForSidebarHydration(page);
    await openGlobalNewWorkspaceComposer(page);
    await selectNewWorkspaceProject(page, {
      projectKey: projectA.projectKey,
      projectDisplayName: projectA.projectDisplayName,
    });
    await expect(
      page
        .getByRole("button", { name: `Select model (${MODEL_LABEL})`, exact: true })
        .filter({ visible: true }),
    ).toHaveCount(0);
  } finally {
    await provider.restore();
    await projectA.cleanup();
    await projectB.cleanup();
  }
});
