// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type {ReactNode} from "react";
import type {ConnectorManifest,RuntimeSettingsDetails,RuntimeSettingsOverrides,RuntimeSettingsField} from "@sciencediscovery/schema";
import { connectorName, groupConnectors, type ConnectorGroupLabel } from "./connector-picker.js";
export function McpSettingsSection({details,draft,setDraft,connectors,allowInheritance,disabled,t,renderSource}:{
details:RuntimeSettingsDetails;draft:RuntimeSettingsOverrides;setDraft:(update:(value:RuntimeSettingsOverrides)=>RuntimeSettingsOverrides)=>void;
connectors:ConnectorManifest[];allowInheritance:boolean;disabled:boolean;
t:(key:"settings.connectors" | "scopedSettings.connectorModeAria" | "scopedSettings.inheritCount" | "scopedSettings.overrideCount" | ConnectorGroupLabel,variables?:Record<string,string|number>)=>string;renderSource:(field:RuntimeSettingsField)=>ReactNode;
}) {
 const saving=false;
 const connectorOverride=draft.enabledConnectorIds!==undefined;
  function setArrayMode(field: "enabledConnectorIds", override: boolean): void {
    setDraft((current) => {
      const next = { ...current };
      if (override) next[field] = [];
      else delete next[field];
      return next;
    });
  }


  function toggleArrayValue(field: "enabledConnectorIds" | "enabledSkillIds", value: string): void {
    setDraft((current) => {
      const selected = current[field] ?? [];
      const nextValues = selected.includes(value as never)
        ? selected.filter((item) => item !== value)
        : [...selected, value] as never[];
      return { ...current, [field]: nextValues };
    });
  }


return <>      <fieldset className="settings-array" disabled={disabled || saving}>
        <legend>{t("settings.connectors")}</legend>
        {allowInheritance ? <select aria-label={t("scopedSettings.connectorModeAria")} value={connectorOverride ? "override" : "inherit"} onChange={(event) => setArrayMode("enabledConnectorIds", event.target.value === "override")}>
          <option value="inherit">{t("scopedSettings.inheritCount", { count: details.effective.enabledConnectorIds.length })}</option>
          <option value="override">{t("scopedSettings.overrideCount", { count: draft.enabledConnectorIds?.length ?? 0 })}</option>
        </select> : null}
        {/* Same groups as the composer picker, so Web access and custom MCP servers do not read as literature sources. */}
        {connectorOverride || !allowInheritance ? groupConnectors(connectors).map((group) => <div aria-label={t(group.label)} className="settings-choice-group" key={group.label} role="group">
          <small className="settings-choice-group-label">{t(group.label)}</small>
          <div className="settings-choices">
            {group.items.map((connector) => <label key={connector.id}><input type="checkbox" checked={draft.enabledConnectorIds?.includes(connector.id) ?? false} onChange={() => toggleArrayValue("enabledConnectorIds", connector.id)} /><span>{connector.displayName ?? connectorName(connector.id)}</span></label>)}
          </div>
        </div>) : null}
        {allowInheritance ? renderSource("enabledConnectorIds") : null}
      </fieldset>

</>;
}
export { ConnectorPicker, connectorName, groupConnectors } from "./connector-picker.js";
export type { ConnectorGroupLabel } from "./connector-picker.js";
