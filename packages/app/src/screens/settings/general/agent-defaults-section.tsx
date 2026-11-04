import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@/components/settings";
import { useAppSettings } from "@/hooks/use-settings";

export function AgentDefaultsSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const changeRememberModelPerProject = useCallback(
    (rememberModelPerProject: boolean) => void updateSettings({ rememberModelPerProject }),
    [updateSettings],
  );
  return (
    <SettingsSection title={t("settings.general.agentDefaults")}>
      <SettingsCard>
        <SettingsSwitch
          label={t("settings.general.rememberModelPerProject.label")}
          hint={t("settings.general.rememberModelPerProject.description")}
          value={settings.rememberModelPerProject}
          onValueChange={changeRememberModelPerProject}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
