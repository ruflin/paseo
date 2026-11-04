import { useCallback, useMemo } from "react";
import {
  buildProjectPreferenceKey,
  resolveProjectPreferences,
  scopePreferenceUpdate,
} from "@/create-agent-preferences/project-preferences";
import type { FormPreferenceUpdate } from "@/create-agent-preferences/service";
import { useAppSettings } from "@/hooks/use-settings";
import { useSessionStore } from "@/stores/session-store";
import { useProjectIdentityForDirectory } from "@/stores/session-store-hooks";
import { useFormPreferences, type UseFormPreferencesReturn } from "./use-form-preferences";

/**
 * The key of the project that owns `directory`, or null when new agents are not remembered per
 * project. Every per-project read and write goes through this key, so the setting is checked here
 * and nowhere else.
 */
export function useProjectPreferenceKey(
  serverId: string | null,
  directory: string | null,
): string | null {
  const { settings } = useAppSettings();
  const project = useProjectIdentityForDirectory(
    settings.rememberModelPerProject ? serverId : null,
    directory?.trim() || null,
  );
  return useMemo(
    () =>
      serverId && project
        ? buildProjectPreferenceKey({
            serverId,
            projectId: project.projectId,
            projectKey: project.projectKey,
          })
        : null,
    [project, serverId],
  );
}

/**
 * `useFormPreferences` for a surface that works inside one project: reads prefer what was chosen
 * in that project, and selection updates are remembered for it as well as globally.
 */
export function useProjectFormPreferences(input: {
  serverId: string | null;
  directory: string | null;
}): UseFormPreferencesReturn {
  const { preferences, isLoading, updatePreferences } = useFormPreferences();
  const projectPreferenceKey = useProjectPreferenceKey(input.serverId, input.directory);

  const projectPreferences = useMemo(
    () => resolveProjectPreferences(preferences, projectPreferenceKey),
    [preferences, projectPreferenceKey],
  );
  const updateProjectPreferences = useCallback(
    (update: FormPreferenceUpdate) =>
      updatePreferences(scopePreferenceUpdate(update, projectPreferenceKey)),
    [projectPreferenceKey, updatePreferences],
  );

  return {
    preferences: projectPreferences,
    isLoading,
    updatePreferences: updateProjectPreferences,
  };
}

/** `useProjectFormPreferences` for a surface that controls a running agent, in that agent's project. */
export function useAgentProjectFormPreferences(input: {
  serverId: string | null;
  agentId: string | null;
}): UseFormPreferencesReturn {
  const { serverId, agentId } = input;
  const directory = useSessionStore((state) =>
    serverId && agentId ? (state.sessions[serverId]?.agents?.get(agentId)?.cwd ?? null) : null,
  );
  return useProjectFormPreferences({ serverId, directory });
}
