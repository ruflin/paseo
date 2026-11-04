/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mergeCreateAgentSelectionPreferences,
  type FormPreferences,
} from "@/create-agent-preferences/preferences";
import { createAgentPreferencesService } from "@/create-agent-preferences/service";
import { seedSessionWorkspaces } from "@/test/seed-session";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS } from "./use-settings/storage";
import { useProjectFormPreferences } from "./use-project-form-preferences";

const { asyncStorage } = vi.hoisted(() => ({
  asyncStorage: new Map<string, string>(),
}));

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => asyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      asyncStorage.set(key, value);
    },
    removeItem: async (key: string) => {
      asyncStorage.delete(key);
    },
  },
}));

const SERVER_ID = "host-1";
const WEB = "/dev/web";
const API = "/dev/api";
const DOCS = "/dev/docs";

function workspaceFor(input: { name: string; directory: string }): WorkspaceDescriptor {
  return {
    createdAt: null,
    lastUserMessageAt: null,
    id: `wks_${input.name}`,
    projectId: `prj_${input.name}`,
    projectDisplayName: input.name,
    projectRootPath: input.directory,
    workspaceDirectory: input.directory,
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    project: {
      projectKey: `github.com/acme/${input.name}`,
      projectName: input.name,
      checkout: {
        cwd: input.directory,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  };
}

function selectClaudeModel(modelId: string) {
  return (current: FormPreferences) =>
    mergeCreateAgentSelectionPreferences({
      preferences: current,
      provider: "claude",
      modelId,
    });
}

function setRememberPerProject(queryClient: QueryClient, rememberModelPerProject: boolean) {
  queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, {
    ...DEFAULT_CLIENT_SETTINGS,
    rememberModelPerProject,
  });
}

async function renderProjects(input: { rememberModelPerProject: boolean }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setRememberPerProject(queryClient, input.rememberModelPerProject);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(
    () => ({
      web: useProjectFormPreferences({ serverId: SERVER_ID, directory: WEB }),
      api: useProjectFormPreferences({ serverId: SERVER_ID, directory: API }),
      docs: useProjectFormPreferences({ serverId: SERVER_ID, directory: DOCS }),
    }),
    { wrapper },
  );
  await waitFor(() => expect(rendered.result.current.web.isLoading).toBe(false));
  return { ...rendered, queryClient };
}

function modelIn(preferences: FormPreferences): string | undefined {
  return preferences.providerPreferences?.claude?.model;
}

describe("useProjectFormPreferences", () => {
  beforeEach(async () => {
    asyncStorage.clear();
    await createAgentPreferencesService.update(() => ({}));
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
    seedSessionWorkspaces(
      SERVER_ID,
      new Map(
        [
          { name: "web", directory: WEB },
          { name: "api", directory: API },
          { name: "docs", directory: DOCS },
        ].map((project) => [`wks_${project.name}`, workspaceFor(project)]),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  it("remembers a different model in each project when the setting is on", async () => {
    const { result } = await renderProjects({ rememberModelPerProject: true });

    await act(() => result.current.web.updatePreferences(selectClaudeModel("opus")));
    await act(() => result.current.api.updatePreferences(selectClaudeModel("haiku")));

    await waitFor(() => expect(modelIn(result.current.web.preferences)).toBe("opus"));
    await waitFor(() => expect(modelIn(result.current.api.preferences)).toBe("haiku"));
  });

  it("starts a project with no history from the model last used anywhere", async () => {
    const { result } = await renderProjects({ rememberModelPerProject: true });

    await act(() => result.current.web.updatePreferences(selectClaudeModel("opus")));
    await act(() => result.current.api.updatePreferences(selectClaudeModel("haiku")));

    await waitFor(() => expect(modelIn(result.current.docs.preferences)).toBe("haiku"));
  });

  it("uses one model for every project when the setting is off", async () => {
    const { result } = await renderProjects({ rememberModelPerProject: false });

    await act(() => result.current.web.updatePreferences(selectClaudeModel("opus")));
    await act(() => result.current.api.updatePreferences(selectClaudeModel("haiku")));

    await waitFor(() => expect(modelIn(result.current.web.preferences)).toBe("haiku"));
    await waitFor(() => expect(modelIn(result.current.api.preferences)).toBe("haiku"));
  });

  it("keeps each project's model while the setting is off and brings it back when turned on", async () => {
    const { result, queryClient } = await renderProjects({ rememberModelPerProject: true });
    await act(() => result.current.web.updatePreferences(selectClaudeModel("opus")));
    await act(() => result.current.api.updatePreferences(selectClaudeModel("haiku")));

    act(() => setRememberPerProject(queryClient, false));
    await waitFor(() => expect(modelIn(result.current.web.preferences)).toBe("haiku"));

    act(() => setRememberPerProject(queryClient, true));
    await waitFor(() => expect(modelIn(result.current.web.preferences)).toBe("opus"));
  });
});
