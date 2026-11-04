import { describe, expect, it } from "vitest";
import { mergeCreateAgentSelectionPreferences, parseFormPreferences } from "./preferences";
import type { FormPreferences } from "./preferences";
import {
  buildProjectPreferenceKey,
  resolveProjectPreferences,
  scopePreferenceUpdate,
} from "./project-preferences";
import { CreateAgentPreferencesService } from "./service";
import type { CreateAgentPreferenceStorage } from "./storage";

class InMemoryPreferenceStorage implements CreateAgentPreferenceStorage {
  private stored: unknown = null;

  async read(): Promise<unknown> {
    return this.stored;
  }

  async write(preferences: FormPreferences): Promise<void> {
    this.stored = structuredClone(preferences);
  }
}

const WEB = "key:github.com/acme/web";
const API = "key:github.com/acme/api";

function selectModel(provider: "claude" | "codex", modelId: string) {
  return (current: FormPreferences) =>
    mergeCreateAgentSelectionPreferences({ preferences: current, provider, modelId });
}

describe("buildProjectPreferenceKey", () => {
  it("uses the shared project key so one repo on two hosts remembers one model", () => {
    const onLaptop = buildProjectPreferenceKey({
      serverId: "laptop",
      projectId: "prj_1",
      projectKey: "github.com/acme/web",
    });
    const onDesktop = buildProjectPreferenceKey({
      serverId: "desktop",
      projectId: "prj_9",
      projectKey: "github.com/acme/web",
    });

    expect(onLaptop).toBe(WEB);
    expect(onDesktop).toBe(WEB);
  });

  it("falls back to the host and project id when the daemon sends no project key", () => {
    expect(
      buildProjectPreferenceKey({ serverId: "laptop", projectId: "prj_1", projectKey: null }),
    ).toBe("host:laptop:prj_1");
  });
});

describe("resolveProjectPreferences", () => {
  const stored: FormPreferences = {
    provider: "codex",
    providerPreferences: {
      codex: { model: "gpt-5.5", mode: "full-access", thinkingByModel: { "gpt-5.5": "low" } },
      claude: { model: "haiku" },
    },
    projectPreferences: {
      [WEB]: {
        provider: "claude",
        providerPreferences: {
          claude: { model: "opus" },
          codex: { model: "gpt-5.4", thinkingByModel: { "gpt-5.4": "high" } },
        },
      },
    },
  };

  it("returns the stored preferences untouched when no project applies", () => {
    expect(resolveProjectPreferences(stored, null)).toBe(stored);
    expect(resolveProjectPreferences(stored, API)).toBe(stored);
  });

  it("lets the project's provider and model win over the global ones", () => {
    const resolved = resolveProjectPreferences(stored, WEB);

    expect(resolved.provider).toBe("claude");
    expect(resolved.providerPreferences?.claude?.model).toBe("opus");
  });

  it("keeps global fields the project never set, and merges thinking per model", () => {
    const resolved = resolveProjectPreferences(stored, WEB);

    expect(resolved.providerPreferences?.codex).toEqual({
      model: "gpt-5.4",
      mode: "full-access",
      thinkingByModel: { "gpt-5.5": "low", "gpt-5.4": "high" },
    });
  });

  it("does not change the stored preferences it was given", () => {
    const before = structuredClone(stored);

    resolveProjectPreferences(stored, WEB);

    expect(stored).toEqual(before);
  });
});

describe("scopePreferenceUpdate", () => {
  it("writes both the global slot and the project slot", () => {
    const update = scopePreferenceUpdate(selectModel("claude", "opus"), WEB);

    const next = typeof update === "function" ? update({}) : null;

    expect(next).toEqual({
      provider: "claude",
      providerPreferences: { claude: { model: "opus" } },
      projectPreferences: {
        [WEB]: { provider: "claude", providerPreferences: { claude: { model: "opus" } } },
      },
    });
  });

  it("leaves other projects' slots alone", () => {
    const withApi = scopePreferenceUpdate(selectModel("claude", "haiku"), API);
    const withWeb = scopePreferenceUpdate(selectModel("claude", "opus"), WEB);

    const next =
      typeof withApi === "function" && typeof withWeb === "function" ? withWeb(withApi({})) : null;

    expect(next?.projectPreferences?.[API]?.providerPreferences?.claude?.model).toBe("haiku");
    expect(next?.projectPreferences?.[WEB]?.providerPreferences?.claude?.model).toBe("opus");
    expect(next?.providerPreferences?.claude?.model).toBe("opus");
  });

  it("passes the update through unchanged when not remembering per project", () => {
    const update = selectModel("claude", "opus");

    expect(scopePreferenceUpdate(update, null)).toBe(update);
  });

  it("passes object updates through unchanged", () => {
    const update = { isolation: "worktree" } as const;

    expect(scopePreferenceUpdate(update, WEB)).toBe(update);
  });
});

describe("remembering a model per project", () => {
  async function openProject(service: CreateAgentPreferencesService, projectKey: string | null) {
    return resolveProjectPreferences(await service.load(), projectKey);
  }

  it("brings back each project's own model and gives a new project the latest global one", async () => {
    const service = new CreateAgentPreferencesService(new InMemoryPreferenceStorage());

    await service.update(scopePreferenceUpdate(selectModel("claude", "opus"), WEB));
    await service.update(scopePreferenceUpdate(selectModel("claude", "haiku"), API));

    expect((await openProject(service, WEB)).providerPreferences?.claude?.model).toBe("opus");
    expect((await openProject(service, API)).providerPreferences?.claude?.model).toBe("haiku");
    expect(
      (await openProject(service, "key:github.com/acme/new")).providerPreferences?.claude?.model,
    ).toBe("haiku");
  });

  it("ignores project memory when remembering per project is off", async () => {
    const service = new CreateAgentPreferencesService(new InMemoryPreferenceStorage());

    await service.update(scopePreferenceUpdate(selectModel("claude", "opus"), WEB));
    await service.update(scopePreferenceUpdate(selectModel("claude", "haiku"), null));

    expect((await openProject(service, null)).providerPreferences?.claude?.model).toBe("haiku");
    expect((await openProject(service, WEB)).providerPreferences?.claude?.model).toBe("opus");
  });

  it("survives a round trip through storage", async () => {
    const service = new CreateAgentPreferencesService(new InMemoryPreferenceStorage());
    await service.update(scopePreferenceUpdate(selectModel("codex", "gpt-5.5"), WEB));

    const reloaded = parseFormPreferences(JSON.parse(JSON.stringify(await service.load())));

    expect(resolveProjectPreferences(reloaded, WEB).providerPreferences?.codex?.model).toBe(
      "gpt-5.5",
    );
  });
});
