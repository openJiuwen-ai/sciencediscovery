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
      <p>选择科研模板和探索强度。目标与证据在启动研究时填写。</p>
    </div>
    <div className="idea-tree-grid">
      <label className="idea-tree-field">
        <span>科研模板</span>
        <select
          onChange={(event) => onChange({ ...draft, templateId: event.target.value as IdeaTreeSettingsDraft["templateId"] })}
          value={draft.templateId}
        >
          <option value="scientific-hypothesis-general/v1">通用科研假设探索</option>
          <option value="water-treatment-materials/v1">水处理材料设计</option>
        </select>
      </label>
      <label className="idea-tree-field">
        <span>探索强度</span>
        <select
          onChange={(event) => onChange({ ...draft, explorationIntensity: event.target.value as IdeaTreeSettingsDraft["explorationIntensity"] })}
          value={draft.explorationIntensity}
        >
          <option value="quick">快速：少量路径，快速判断</option>
          <option value="standard">标准：平衡探索与验证</option>
          <option value="deep">深入：更多分支和验证轮次</option>
        </select>
      </label>
    </div>
    <p className="config-note">模板会在研究启动时保存快照，后续模板更新不会改变正在运行的研究。</p>
    <div className="settings-actions">
      <button className="primary-button" disabled={saving} onClick={onSave} type="button">
        {saving ? t("common.saving" as MessageKey) : t("common.save" as MessageKey)}
      </button>
    </div>
  </section>;
}
