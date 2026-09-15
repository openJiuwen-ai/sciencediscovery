// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type {ReactNode} from "react";
import type {ConnectorManifest,RuntimeSettingsDetails,RuntimeSettingsOverrides,RuntimeSettingsField} from "@sciencediscovery/schema";
export function McpSettingsSection({details,draft,setDraft,connectors,allowInheritance,disabled,t,renderSource}:{
details:RuntimeSettingsDetails;draft:RuntimeSettingsOverrides;setDraft:(update:(value:RuntimeSettingsOverrides)=>RuntimeSettingsOverrides)=>void;
connectors:ConnectorManifest[];allowInheritance:boolean;disabled:boolean;
t:(key:"settings.connectors" | "scopedSettings.connectorModeAria" | "scopedSettings.inheritCount" | "scopedSettings.overrideCount",variables?:Record<string,string|number>)=>string;renderSource:(field:RuntimeSettingsField)=>ReactNode;
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
        {connectorOverride || !allowInheritance ? <div className="settings-choices">
          {connectors.map((connector) => <label key={connector.id}><input type="checkbox" checked={draft.enabledConnectorIds?.includes(connector.id) ?? false} onChange={() => toggleArrayValue("enabledConnectorIds", connector.id)} /><span>{connector.displayName ?? connector.id}</span></label>)}
        </div> : null}
        {allowInheritance ? renderSource("enabledConnectorIds") : null}
      </fieldset>

</>;
}
export { ConnectorPicker, connectorName } from "./connector-picker.js";
