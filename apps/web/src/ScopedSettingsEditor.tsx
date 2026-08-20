// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { useState, type FormEvent, type ReactNode } from "react";

import type {
  ConnectorManifest,
  ModelProfile,
  RuntimeSettingsDetails,
  RuntimeSettingsField,
  RuntimeSettingsOverrides,
  RuntimeSettingsSource,
  SkillDescriptor,
  SkillSelectionMode,
} from "@sciencediscovery/schema";

import { duplicateModelProfileId, modelOptionLabel } from "./modelLabels.js";
import { useLocale, type MessageKey } from "./i18n/index.js";

const FIELD_LABELS = {
  enabledConnectorIds: "settings.connectors",
  enabledSkillIds: "settings.skills",
  modelId: "settings.taskModel",
  skillSelectionMode: "settings.skills",
} satisfies Pick<Record<RuntimeSettingsField, MessageKey>, "enabledConnectorIds" | "enabledSkillIds" | "modelId" | "skillSelectionMode">;

/**
 * Which skill controls a scope may show. Global no longer configures skills at
 * all; Project is the root skill layer, so only Session can inherit.
 */
export type SkillScope = "global" | "project" | "session";

const SKILL_MODE_LABELS = {
  all: "settings.skillModeAll",
  selected: "settings.skillModeSelected",
} satisfies Record<SkillSelectionMode, MessageKey>;

function sourceLabel(source: RuntimeSettingsSource): string {
  if (source === "unset") return "Built-in fallback";
  return `${source[0]!.toUpperCase()}${source.slice(1)} setting`;
}

function effectiveModelName(modelId: string | undefined, models: ModelProfile[]): string {
  if (!modelId) return "Not configured";
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) return modelId;
  return duplicateModelProfileId(model, models) ? modelOptionLabel(model, models) : model.name;
}

function SettingsSource({ details, field }: { details: RuntimeSettingsDetails; field: RuntimeSettingsField }) {
  return <small className="settings-source">Effective: {sourceLabel(details.sources[field])}</small>;
}

export function globalSettingsDraft(details: RuntimeSettingsDetails): RuntimeSettingsOverrides {
  return {
    enabledConnectorIds: [...details.effective.enabledConnectorIds],
    ...(details.effective.modelId ? { modelId: details.effective.modelId } : {}),
  };
}

export function ScopedSettingsEditor({
  allowInheritance = true,
  beforeFields,
  connectors,
  description,
  details,
  disabled = false,
  draft: controlledDraft,
  models,
  onCancel,
  onDraftChange,
  onSave,
  scopeLabel,
  skills,
  skillScope = "session",
  submitLabel,
  showActions = true,
}: {
  allowInheritance?: boolean;
  beforeFields?: ReactNode | ((draft: RuntimeSettingsOverrides) => ReactNode);
  connectors: ConnectorManifest[];
  description?: string;
  details: RuntimeSettingsDetails;
  disabled?: boolean;
  draft?: RuntimeSettingsOverrides;
  models: ModelProfile[];
  onCancel?: () => void;
  onDraftChange?: (draft: RuntimeSettingsOverrides) => void;
  onSave: (overrides: RuntimeSettingsOverrides) => Promise<void> | void;
  scopeLabel: string;
  skills: SkillDescriptor[];
  skillScope?: SkillScope;
  submitLabel?: string;
  showActions?: boolean;
}) {
  const { t } = useLocale();
  const [localDraft, setLocalDraft] = useState<RuntimeSettingsOverrides>(() => allowInheritance ? details.overrides : globalSettingsDraft(details));
  const [saving, setSaving] = useState(false);

  const draft = controlledDraft ?? localDraft;
  const setDraft = (update: (current: RuntimeSettingsOverrides) => RuntimeSettingsOverrides): void => {
    const next = update(draft);
    if (onDraftChange) onDraftChange(next);
    else setLocalDraft(next);
  };

  const inheritedLabel = (field: RuntimeSettingsField, value: string) =>
    `Inherit · ${value} (${sourceLabel(details.sources[field])})`;

  function setScalar(field: "modelId", value: string): void {
    setDraft((current) => {
      const next = { ...current };
      if (value) next[field] = value;
      else delete next[field];
      return next;
    });
  }

  function setArrayMode(field: "enabledConnectorIds", override: boolean): void {
    setDraft((current) => {
      const next = { ...current };
      if (override) next[field] = [];
      else delete next[field];
      return next;
    });
  }

  /** `inherit` drops both skill fields; `all` needs no whitelist to be stored. */
  function setSkillMode(value: "inherit" | SkillSelectionMode): void {
    setDraft((current) => {
      const next = { ...current };
      delete next.enabledSkillIds;
      if (value === "inherit") delete next.skillSelectionMode;
      else if (value === "all") next.skillSelectionMode = "all";
      else {
        next.skillSelectionMode = "selected";
        next.enabledSkillIds = current.enabledSkillIds ?? [];
      }
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

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  }

  const connectorOverride = draft.enabledConnectorIds !== undefined;
  const skillInheritable = skillScope === "session";
  // Project is the root skill layer, so an unset mode there simply means `all`.
  const skillMode: "inherit" | SkillSelectionMode = draft.skillSelectionMode
    ?? (skillInheritable ? "inherit" : "all");
  const skillWhitelist = skillMode === "selected";

  return (
    <form className="scoped-settings" onSubmit={(event) => void submit(event)}>
      <div className="editor-heading">
        <strong>{t("settings.runtimeTitle", { scope: scopeLabel })}</strong>
        <small>{description ?? (allowInheritance
          ? t("settings.runtimeInheritedHelp")
          : t("settings.runtimeGlobalHelp"))}</small>
      </div>

      {typeof beforeFields === "function" ? beforeFields(draft) : beforeFields}

      <label className="settings-field">
        <span>{t(FIELD_LABELS.modelId)}</span>
        <select disabled={disabled || saving} value={draft.modelId ?? ""} onChange={(event) => setScalar("modelId", event.target.value)}>
          <option value="">{allowInheritance ? inheritedLabel("modelId", effectiveModelName(details.effective.modelId, models)) : "Not configured"}</option>
          {models.map((model) => <option key={model.id} value={model.id}>{allowInheritance ? "Override · " : ""}{modelOptionLabel(model, models)}</option>)}
        </select>
        {allowInheritance ? <SettingsSource details={details} field="modelId" /> : null}
      </label>

      <fieldset className="settings-array" disabled={disabled || saving}>
        <legend>{t(FIELD_LABELS.enabledConnectorIds)}</legend>
        {allowInheritance ? <select aria-label="Connector settings mode" value={connectorOverride ? "override" : "inherit"} onChange={(event) => setArrayMode("enabledConnectorIds", event.target.value === "override")}>
          <option value="inherit">Inherit · {details.effective.enabledConnectorIds.length} enabled</option>
          <option value="override">Override · {draft.enabledConnectorIds?.length ?? 0} selected</option>
        </select> : null}
        {connectorOverride || !allowInheritance ? <div className="settings-choices">
          {connectors.map((connector) => <label key={connector.id}><input type="checkbox" checked={draft.enabledConnectorIds?.includes(connector.id) ?? false} onChange={() => toggleArrayValue("enabledConnectorIds", connector.id)} /><span>{connector.id}</span></label>)}
        </div> : null}
        {allowInheritance ? <SettingsSource details={details} field="enabledConnectorIds" /> : null}
      </fieldset>

      {skillScope === "global" ? null : <fieldset className="settings-array" disabled={disabled || saving}>
        <legend>{t(FIELD_LABELS.skillSelectionMode)}</legend>
        <select aria-label={t("settings.skillModeAria")} value={skillMode} onChange={(event) => setSkillMode(event.target.value as "inherit" | SkillSelectionMode)}>
          {skillInheritable ? <option value="inherit">
            {t("settings.skillModeInherit", { mode: t(SKILL_MODE_LABELS[details.effective.skillSelectionMode]), count: details.effective.enabledSkillIds.length })}
          </option> : null}
          <option value="all">{t(SKILL_MODE_LABELS.all)}</option>
          <option value="selected">{t(SKILL_MODE_LABELS.selected)}</option>
        </select>
        {skillWhitelist ? <div className="settings-choices">
          {skills.map((skill) => <label key={skill.id}><input type="checkbox" checked={draft.enabledSkillIds?.includes(skill.id) ?? false} onChange={() => toggleArrayValue("enabledSkillIds", skill.id)} /><span>{skill.name}<small>{skill.source === "built-in" ? t("common.builtIn") : t("settings.managedRevision", { revision: skill.currentRevision })}</small></span></label>)}
          {!skills.length ? <p className="settings-choice-empty">{t("settings.noSkills")}</p> : null}
        </div> : <small className="settings-hint">{t("settings.skillModeAllHint")}</small>}
        {skillInheritable ? <SettingsSource details={details} field="skillSelectionMode" /> : null}
      </fieldset>}

      {disabled ? <p className="settings-readonly">{t("settings.archivedReadonly")}</p> : null}
      {!showActions ? null : onCancel ? <div className="dialog-actions">
        <button className="secondary-button" disabled={saving} onClick={onCancel} type="button">{t("common.cancel")}</button>
        <button className="primary-button" disabled={disabled || saving} type="submit">{saving ? t("common.saving") : submitLabel ?? t("settings.saveScope", { scope: scopeLabel })}</button>
      </div> : <button className="primary-button" disabled={disabled || saving} type="submit">{saving ? t("common.saving") : submitLabel ?? t("settings.saveScope", { scope: scopeLabel })}</button>}
    </form>
  );
}
