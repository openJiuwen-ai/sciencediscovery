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
  EnabledSkillLibrary,
  ModelProfile,
  RuntimeSettingsDetails,
  RuntimeSettingsField,
  RuntimeSettingsOverrides,
  RuntimeSettingsSource,
  SkillDescriptor,
  SkillLibrary,
  SkillSelectionMode,
} from "@sciencediscovery/schema";

import { PluginSettingsSections } from "./plugins/settings.js";
import { normalizeSkillLibraryMounts } from "@sciencediscovery/skill/web";

import { modelOptionLabel } from "./modelLabels.js";
import { useLocale, type MessageKey } from "./i18n/index.js";

const FIELD_LABELS = {
  enabledConnectorIds: "settings.connectors",
  enabledSkillLibraries: "settings.skillLibraries",
  enabledSkillIds: "settings.skills",
  modelId: "settings.taskModel",
  skillSelectionMode: "settings.skills",
} satisfies Pick<Record<RuntimeSettingsField, MessageKey>, "enabledConnectorIds" | "enabledSkillIds" | "enabledSkillLibraries" | "modelId" | "skillSelectionMode">;

/**
 * Which skill controls a scope may show. Global no longer configures skills at
 * all; Project is the root skill layer, so only Session can inherit.
 */
export type SkillScope = "global" | "project" | "session";

const SKILL_MODE_LABELS = {
  all: "settings.skillModeAll",
  selected: "settings.skillModeSelected",
} satisfies Record<SkillSelectionMode, MessageKey>;

const SOURCE_LABELS = {
  global: "scopedSettings.source.global",
  project: "scopedSettings.source.project",
  session: "scopedSettings.source.session",
  unset: "scopedSettings.sourceBuiltIn",
} satisfies Record<RuntimeSettingsSource, MessageKey>;

function sourceLabel(source: RuntimeSettingsSource | undefined, t: ReturnType<typeof useLocale>["t"]): string {
  return t(SOURCE_LABELS[source ?? "unset"]);
}

function effectiveModelName(
  modelId: string | undefined,
  models: ModelProfile[],
  t: ReturnType<typeof useLocale>["t"],
): string {
  if (!modelId) return t("common.notConfigured");
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) return modelId;
  return modelOptionLabel(model, models, t);
}

function SettingsSource({ details, field }: { details: RuntimeSettingsDetails; field: RuntimeSettingsField }) {
  const { t } = useLocale();
  return <small className="settings-source">{t("scopedSettings.effective", { source: sourceLabel(details.sources[field], t) })}</small>;
}

export function globalSettingsDraft(details: RuntimeSettingsDetails): RuntimeSettingsOverrides {
  return {
    ...(details.overrides.defaultApprovalMode ? { defaultApprovalMode: details.overrides.defaultApprovalMode } : {}),
    enabledConnectorIds: [...details.effective.enabledConnectorIds],
    ...(details.effective.plugins ? { plugins: structuredClone(details.effective.plugins) } : {}),
    ...(details.effective.modelId ? { modelId: details.effective.modelId } : {}),
  };
}

export function ScopedSettingsEditor({
  allowInheritance = true,
  beforeFields,
  afterFields,
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
  skillLibraries = [],
  skills,
  skillScope = "session",
  skillsBackend,
  submitLabel,
  showActions = true,
}: {
  allowInheritance?: boolean;
  beforeFields?: ReactNode | ((draft: RuntimeSettingsOverrides) => ReactNode);
  afterFields?: ReactNode;
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
  skillLibraries?: SkillLibrary[];
  skills: SkillDescriptor[];
  skillScope?: SkillScope;
  /** The agent backend: with JiuwenSwarm, skills are not chosen per Project or Session. */
  skillsBackend?: "jiuwenswarm" | "native";
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
    t("scopedSettings.inheritLabel", { value, source: sourceLabel(details.sources[field], t) });

  function setScalar(field: "modelId", value: string): void {
    setDraft((current) => {
      const next = { ...current };
      if (value) next[field] = value;
      else delete next[field];
      return next;
    });
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    try {
      const next = skillScope === "global"
        ? draft
        : { ...draft, enabledSkillLibraries: normalizeSkillLibraryMounts(draft.enabledSkillLibraries ?? skillLibraryMounts, skillLibraries) };
      await onSave(next);
    } finally {
      setSaving(false);
    }
  }

  const skillLibraryMounts = normalizeSkillLibraryMounts(draft.enabledSkillLibraries ?? details.effective.enabledSkillLibraries, skillLibraries);
  return (
    <form className="scoped-settings" onSubmit={(event) => void submit(event)}>
      <div className="editor-heading">
        <strong>{t("settings.runtimeTitle", { scope: scopeLabel })}</strong>
        <small>{description ?? (allowInheritance
          ? t("settings.runtimeInheritedHelp")
          : t("settings.runtimeGlobalHelp"))}</small>
      </div>

      {typeof beforeFields === "function" ? beforeFields(draft) : beforeFields}

      {skillScope !== "session" ? <label className="settings-field">
        <span>{t("settings.defaultApprovalMode")}</span>
        <select disabled={disabled || saving} value={draft.defaultApprovalMode ?? ""} onChange={(event) => {
          const value = event.target.value;
          setDraft((current) => {
            const next = { ...current };
            if (value === "always_allow" || value === "ask_for_dangerous") next.defaultApprovalMode = value;
            else delete next.defaultApprovalMode;
            return next;
          });
        }}>
          <option value="">{allowInheritance ? t("settings.approvalInheritGlobal") : t("settings.approvalBuiltInAsk")}</option>
          <option value="ask_for_dangerous">{t("timeline.approvalModeAsk")}</option>
          <option value="always_allow">{t("timeline.approvalModeAlwaysAllow")}</option>
        </select>
        <small>{t("settings.defaultApprovalHelp")}</small>
        <small>{t("settings.approvalEffective", { mode: t(details.effective.defaultApprovalMode === "always_allow" ? "timeline.approvalModeAlwaysAllow" : "timeline.approvalModeAsk"), source: sourceLabel(details.sources.defaultApprovalMode, t) })}</small>
      </label> : null}

      <label className="settings-field">
        <span>{t(FIELD_LABELS.modelId)}</span>
        <select disabled={disabled || saving} value={draft.modelId ?? ""} onChange={(event) => setScalar("modelId", event.target.value)}>
          <option value="">{allowInheritance ? inheritedLabel("modelId", effectiveModelName(details.effective.modelId, models, t)) : t("common.notConfigured")}</option>
          {models.map((model) => <option key={model.id} value={model.id}>{allowInheritance ? t("scopedSettings.overrideOption", { label: modelOptionLabel(model, models, t) }) : modelOptionLabel(model, models, t)}</option>)}
        </select>
        {allowInheritance ? <SettingsSource details={details} field="modelId" /> : null}
      </label>

      <PluginSettingsSections {...{ details, draft, setDraft, connectors, allowInheritance, disabled: disabled || saving, t, skillLibraries, skills, skillScope, skillsBackend }} renderSource={(field) => <SettingsSource details={details} field={field} />} />
      {afterFields}
      {disabled ? <p className="settings-readonly">{t("settings.archivedReadonly")}</p> : null}
      {!showActions ? null : onCancel ? <div className="dialog-actions">
        <button className="secondary-button" disabled={saving} onClick={onCancel} type="button">{t("common.cancel")}</button>
        <button className="primary-button" disabled={disabled || saving} type="submit">{saving ? t("common.saving") : submitLabel ?? t("settings.saveScope", { scope: scopeLabel })}</button>
      </div> : <button className="primary-button" disabled={disabled || saving} type="submit">{saving ? t("common.saving") : submitLabel ?? t("settings.saveScope", { scope: scopeLabel })}</button>}
    </form>
  );
}
