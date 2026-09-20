// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ComponentProps } from "react";
import { SkillSettingsSection } from "@sciencediscovery/skill/web";
import { McpSettingsSection } from "@sciencediscovery/mcp/web";
import { manifest as skill } from "@sciencediscovery/skill/manifest";
import { manifest as mcp } from "@sciencediscovery/mcp/manifest";
import { manifest as plan } from "@sciencediscovery/plan/manifest";
import { manifest as scheduler } from "@sciencediscovery/scheduler/manifest";
import { manifest as json } from "@sciencediscovery/artifact-json/manifest";
import { mergePluginSettings, pluginEnabled } from "@sciencediscovery/plugin-sdk";
import { useLocale, type MessageKey } from "../i18n/index.js";

// UI policy only: the backend still supports scoped settings for every plugin.
const internal = [skill, mcp, plan, scheduler];
// A plugin's display name and help text are catalogue keys like every other
// string in the UI: the previous per-entry `zh`/`descriptionZh` fields were a
// second translation mechanism running beside the message catalogue, and new
// strings landed in whichever one the author happened to touch.
const optional: Array<{ manifest: typeof json; nameKey: MessageKey; descriptionKey: MessageKey }> = [
  { manifest: json, nameKey: "plugins.json.name", descriptionKey: "plugins.json.description" },
];
type Props = Omit<ComponentProps<typeof SkillSettingsSection>, "t"> & Omit<ComponentProps<typeof McpSettingsSection>, "t"> & {
  t: ReturnType<typeof useLocale>["t"];
};
/** The host owns slots; feature packages own their fields and rendering. */
const sections = [
  { id: "mcp", render: (props: Props) => <McpSettingsSection {...props} /> },
  { id: "skill", render: (props: Props) => <SkillSettingsSection {...props} /> },
];
export function PluginSettingsSections(props: Props) {
  const { t } = useLocale();
  const effective = mergePluginSettings(props.details.inheritedPlugins, props.draft.plugins);
  const disabledInternal = [
    ...internal.map((manifest) => manifest.id),
    ...Object.keys(effective).filter((id) => id.startsWith("connector.")).sort(),
  ].filter((id) => !pluginEnabled(effective, id));
  return <>
    <details className="plugin-settings">
      <summary>{t("plugins.optional")}</summary>
      <p className="settings-hint">{t("plugins.builtInHint")}</p>
      <p className="settings-hint">{t("plugins.appliesNextRun")}</p>
      {disabledInternal.length > 0 && <p className="settings-hint" role="status">{t("plugins.disabledInternal", { capabilities: disabledInternal.join(t("plugins.listSeparator")) })}</p>}
      {optional.map(({ manifest, nameKey, descriptionKey }) => <label className="settings-field" key={manifest.id}>
        <span>{t(nameKey)}</span>
        <select aria-label={manifest.id + " plugin"} disabled={props.disabled} value={props.draft.plugins?.[manifest.id]?.enabled === undefined ? "inherit" : props.draft.plugins[manifest.id]!.enabled ? "enabled" : "disabled"}
          onChange={(event) => props.setDraft((draft) => {
            const plugins = { ...draft.plugins }, setting = { ...plugins[manifest.id] };
            if (event.target.value === "inherit") delete setting.enabled;
            else setting.enabled = event.target.value === "enabled";
            plugins[manifest.id] = setting;
            return { ...draft, plugins };
          })}>
          <option value="inherit">{t(props.skillScope === "global" ? "plugins.default" : "plugins.inherit")} ({t(pluginEnabled(props.details.inheritedPlugins, manifest.id) ? "plugins.inheritedEnabled" : "plugins.inheritedDisabled")})</option>
          <option value="enabled">{t("plugins.enabled")}</option>
          <option value="disabled">{t("plugins.disabled")}</option>
        </select>
        <small className="settings-hint">{t(descriptionKey)}</small>
      </label>)}
    </details>
    {sections.filter((section) => pluginEnabled(effective, section.id)).map((section) => <div key={section.id} data-plugin={section.id}>{section.render(props)}</div>)}
  </>;
}
