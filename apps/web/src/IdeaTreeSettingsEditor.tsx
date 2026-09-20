// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import { useLocale, type MessageKey } from "./i18n/index.js";
import type { IdeaTreeSettingsDetails, UpdateIdeaTreeSettingsRequest } from "@sciencediscovery/schema";

export interface IdeaTreeSettingsDraft {
  templateId: "scientific-hypothesis-general/v1" | "water-treatment-materials/v1";
  explorationIntensity: "quick" | "standard" | "deep";
}

export function createIdeaTreeSettingsDraft(settings: IdeaTreeSettingsDetails): IdeaTreeSettingsDraft {
  return {
    templateId: settings.templateId === "water-treatment-materials/v1"
      ? "water-treatment-materials/v1"
      : "scientific-hypothesis-general/v1",
    explorationIntensity: settings.explorationIntensity === "quick" || settings.explorationIntensity === "deep"
      ? settings.explorationIntensity
      : "standard",
  };
}

export function ideaTreeSettingsRequest(draft: IdeaTreeSettingsDraft): UpdateIdeaTreeSettingsRequest {
  return { templateId: draft.templateId, explorationIntensity: draft.explorationIntensity };
}

export function ideaTreeWeightsValid(_draft: IdeaTreeSettingsDraft): boolean {
  return true;
}

export function IdeaTreeSettingsEditor({
  draft,
  onChange,
  onSave,
  saving,
}: {
  draft: IdeaTreeSettingsDraft;
  onChange: (draft: IdeaTreeSettingsDraft) => void;
  onSave: () => void;
  saving: boolean;
  settings: IdeaTreeSettingsDetails;
}) {
  const { t } = useLocale();
  return <section aria-label={t("ideaTree.settings" as MessageKey)} className="idea-tree-settings">
    <div className="settings-detail-header">
      <span className="eyebrow">{t("settings.groups.idea-tree.label" as MessageKey)}</span>
      <h3>{t("ideaTree.settings" as MessageKey)}</h3>
      <p>{t("ideaTree.templateHelp")}</p>
    </div>
    <div className="idea-tree-grid">
      <label className="idea-tree-field">
        <span>{t("ideaTree.template")}</span>
        <select
          onChange={(event) => onChange({ ...draft, templateId: event.target.value as IdeaTreeSettingsDraft["templateId"] })}
          value={draft.templateId}
        >
          <option value="scientific-hypothesis-general/v1">{t("ideaTree.template.hypothesisGeneral")}</option>
          <option value="water-treatment-materials/v1">{t("ideaTree.template.waterTreatment")}</option>
        </select>
      </label>
      <label className="idea-tree-field">
        <span>{t("ideaTree.intensity")}</span>
        <select
          onChange={(event) => onChange({ ...draft, explorationIntensity: event.target.value as IdeaTreeSettingsDraft["explorationIntensity"] })}
          value={draft.explorationIntensity}
        >
          <option value="quick">{t("ideaTree.intensity.quick")}</option>
          <option value="standard">{t("ideaTree.intensity.standard")}</option>
          <option value="deep">{t("ideaTree.intensity.deep")}</option>
        </select>
      </label>
    </div>
    <p className="config-note">{t("ideaTree.templateSnapshot")}</p>
    <div className="settings-actions">
      <button className="primary-button" disabled={saving} onClick={onSave} type="button">
        {saving ? t("common.saving" as MessageKey) : t("common.save" as MessageKey)}
      </button>
    </div>
  </section>;
}
