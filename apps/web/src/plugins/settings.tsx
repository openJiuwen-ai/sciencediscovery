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
import { useLocale } from "../i18n/index.js";

// UI policy only: the backend still supports scoped settings for every plugin.
const internal = [skill, mcp, plan, scheduler];
const optional = [
  { manifest: json, name: "JSON preview", zh: "JSON 预览", description: "Raw file content remains available when disabled.", descriptionZh: "关闭专用预览后仍可查看文件原始内容。" },
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
  const zh = useLocale().locale.startsWith("zh");
  const effective = mergePluginSettings(props.details.inheritedPlugins, props.draft.plugins);
  const disabledInternal = [
    ...internal.map((manifest) => manifest.id),
    ...Object.keys(effective).filter((id) => id.startsWith("connector.")).sort(),
  ].filter((id) => !pluginEnabled(effective, id));
  return <>
    <details className="plugin-settings">
      <summary>{zh ? "可选扩展" : "Optional extensions"}</summary>
      <p className="settings-hint">{zh ? "Skill、MCP、Plan 和多 Agent 调度属于内置能力，此处不提供整体开关。请在对应设置中选择具体 Skill、MCP 服务和连接器。" : "Skill, MCP, Plan and multi-agent scheduling are built-in capabilities without master switches here. Select individual Skills, MCP services and connectors in their settings."}</p>
      <p className="settings-hint">{zh ? "运行配置在下一次运行生效；正在运行的任务保持原组合。历史记录不会删除。" : "Changes apply to the next run. Active runs keep their composition; history is retained."}</p>
      {disabledInternal.length > 0 && <p className="settings-hint" role="status">{zh
        ? `已有配置关闭了内置能力：${disabledInternal.join("、")}。本页保存不会自动恢复，请通过配置 API 管理。`
        : `Existing configuration disables built-in capabilities: ${disabledInternal.join(", ")}. Saving here will not re-enable them; manage them through the configuration API.`}</p>}
      {optional.map(({ manifest, name, zh: nameZh, description, descriptionZh }) => <label className="settings-field" key={manifest.id}>
        <span>{zh ? nameZh : name}</span>
        <select aria-label={manifest.id + " plugin"} disabled={props.disabled} value={props.draft.plugins?.[manifest.id]?.enabled === undefined ? "inherit" : props.draft.plugins[manifest.id]!.enabled ? "enabled" : "disabled"}
          onChange={(event) => props.setDraft((draft) => {
            const plugins = { ...draft.plugins }, setting = { ...plugins[manifest.id] };
            if (event.target.value === "inherit") delete setting.enabled;
            else setting.enabled = event.target.value === "enabled";
            plugins[manifest.id] = setting;
            return { ...draft, plugins };
          })}>
          <option value="inherit">{props.skillScope === "global" ? (zh ? "默认" : "Default") : (zh ? "继承" : "Inherit")} ({pluginEnabled(props.details.inheritedPlugins, manifest.id) ? (zh ? "启用" : "enabled") : (zh ? "关闭" : "disabled")})</option>
          <option value="enabled">{zh ? "启用" : "Enabled"}</option>
          <option value="disabled">{zh ? "关闭" : "Disabled"}</option>
        </select>
        <small className="settings-hint">{zh ? descriptionZh : description}</small>
      </label>)}
    </details>
    {sections.filter((section) => pluginEnabled(effective, section.id)).map((section) => <div key={section.id} data-plugin={section.id}>{section.render(props)}</div>)}
  </>;
}
