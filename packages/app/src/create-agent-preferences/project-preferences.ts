import {
  applyProviderPreferenceUpdates,
  type FormPreferences,
  type ProjectSelectionPreferences,
} from "./preferences";
import type { FormPreferenceUpdate } from "./service";

/**
 * The shared project key groups one repo across hosts. Daemons older than v0.2.4 do not send it,
 * so those fall back to the one host's project id.
 */
export function buildProjectPreferenceKey(input: {
  serverId: string;
  projectId: string;
  projectKey: string | null;
}): string {
  if (input.projectKey) {
    return `key:${input.projectKey}`;
  }
  return `host:${input.serverId}:${input.projectId}`;
}

/**
 * The preferences a form in this project reads: the project's own choices over the global ones.
 * A field the project never set keeps its global value.
 */
export function resolveProjectPreferences(
  preferences: FormPreferences,
  projectPreferenceKey: string | null,
): FormPreferences {
  const project = projectPreferenceKey
    ? preferences.projectPreferences?.[projectPreferenceKey]
    : undefined;
  if (!project) {
    return preferences;
  }

  const providerPreferences = { ...preferences.providerPreferences };
  for (const [provider, projectProviderPreferences] of Object.entries(
    project.providerPreferences ?? {},
  )) {
    providerPreferences[provider] = applyProviderPreferenceUpdates(
      providerPreferences[provider] ?? {},
      projectProviderPreferences,
    );
  }
  return {
    ...preferences,
    provider: project.provider ?? preferences.provider,
    providerPreferences,
  };
}

/**
 * Makes a selection update write to the project's slot as well as the global one. The global slot
 * keeps the last selection made anywhere, so a project with no history starts from it and turning
 * the setting off leaves a sensible default behind.
 *
 * Only function updates are scoped: they are the selection merges. Object updates carry
 * unrelated fields such as isolation.
 */
export function scopePreferenceUpdate(
  update: FormPreferenceUpdate,
  projectPreferenceKey: string | null,
): FormPreferenceUpdate {
  if (projectPreferenceKey === null || typeof update !== "function") {
    return update;
  }
  return (current) => {
    const next = update(current);
    const previousProject = current.projectPreferences?.[projectPreferenceKey] ?? {};
    const updatedProject = update(previousProject);
    const project: ProjectSelectionPreferences = {
      provider: updatedProject.provider,
      providerPreferences: updatedProject.providerPreferences,
    };
    return {
      ...next,
      projectPreferences: { ...next.projectPreferences, [projectPreferenceKey]: project },
    };
  };
}
