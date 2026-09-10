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

import type { ReactNode } from "react";

import { useLocale, type MessageKey } from "./i18n/index.js";
import type {
  IdeaTreeAssessorConfig,
  IdeaTreeSettingsDetails,
  UpdateIdeaTreeSettingsRequest,
} from "@sciencediscovery/schema";

export interface IdeaTreeAssessorDraft {
  systemPrompt: string;
  scoringCriteria: string;
  weight: string;
}

export interface IdeaTreeSettingsDraft {
  maxRounds: string;
  candidatesPerRound: string;
  maxTokens: string;
  maxTokensPerCall: string;
  maxDepth: string;
  maxNodes: string;
  maxSearchRounds: string;
  scoreDirection: "maximize" | "minimize";
  designSystemPrompt: string;
  assessorActivity: IdeaTreeAssessorDraft;
  assessorStability: IdeaTreeAssessorDraft;
  assessorSustainability: IdeaTreeAssessorDraft;
  aggregatorSystemPrompt: string;
  propagateInsightSystemPrompt: string;
}

function assessorDraft(config: IdeaTreeAssessorConfig | undefined): IdeaTreeAssessorDraft {
  return {
    systemPrompt: config?.systemPrompt ?? "",
    scoringCriteria: config?.scoringCriteria ?? "",
    weight: typeof config?.weight === "number" ? String(config.weight) : "",
  };
}

export function createIdeaTreeSettingsDraft(settings: IdeaTreeSettingsDetails): IdeaTreeSettingsDraft {
  return {
    maxRounds: String(settings.maxRounds ?? 3),
    candidatesPerRound: String(settings.candidatesPerRound ?? 3),
    maxTokens: String(settings.maxTokens ?? 0),
    maxTokensPerCall: String(settings.maxTokensPerCall ?? 32768),
    maxDepth: String(settings.maxDepth),
    maxNodes: String(settings.maxNodes),
    maxSearchRounds: String(settings.maxSearchRounds),
    scoreDirection: settings.scoreDirection,
    designSystemPrompt: settings.designSystemPrompt ?? "",
    assessorActivity: assessorDraft(settings.assessorActivity),
    assessorStability: assessorDraft(settings.assessorStability),
    assessorSustainability: assessorDraft(settings.assessorSustainability),
    aggregatorSystemPrompt: settings.aggregatorSystemPrompt ?? "",
    propagateInsightSystemPrompt: settings.propagateInsightSystemPrompt ?? "",
  };
}

function trimToNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function assessorRequest(draft: IdeaTreeAssessorDraft): IdeaTreeAssessorConfig {
  const systemPrompt = trimToNullable(draft.systemPrompt);
  const scoringCriteria = trimToNullable(draft.scoringCriteria);
  const weightNumber = Number(draft.weight);
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(scoringCriteria ? { scoringCriteria } : {}),
    ...(draft.weight.trim() && Number.isFinite(weightNumber) ? { weight: weightNumber } : {}),
  };
}

export function ideaTreeSettingsRequest(draft: IdeaTreeSettingsDraft): UpdateIdeaTreeSettingsRequest {
  const maxDepth = Number(draft.maxDepth);
  const maxNodes = Number(draft.maxNodes);
  const maxSearchRounds = Number(draft.maxSearchRounds);
  return {
    maxRounds: Number(draft.maxRounds),
    candidatesPerRound: Number(draft.candidatesPerRound),
    maxTokens: Number(draft.maxTokens) || null,
    maxTokensPerCall: Number(draft.maxTokensPerCall),
    ...(draft.maxDepth.trim() && Number.isFinite(maxDepth) ? { maxDepth } : {}),
    ...(draft.maxNodes.trim() && Number.isFinite(maxNodes) ? { maxNodes } : {}),
    ...(draft.maxSearchRounds.trim() && Number.isFinite(maxSearchRounds) ? { maxSearchRounds } : {}),
    scoreDirection: draft.scoreDirection,
    ...(() => {
      const value = trimToNullable(draft.designSystemPrompt);
      return { designSystemPrompt: value };
    })(),
    assessorActivity: assessorRequest(draft.assessorActivity),
    assessorStability: assessorRequest(draft.assessorStability),
    assessorSustainability: assessorRequest(draft.assessorSustainability),
    ...(() => {
      const value = trimToNullable(draft.aggregatorSystemPrompt);
      return { aggregatorSystemPrompt: value };
    })(),
    ...(() => {
      const value = trimToNullable(draft.propagateInsightSystemPrompt);
      return { propagateInsightSystemPrompt: value };
    })(),
  };
}

/**
 * Weight validation. Either all three Assessor weights are blank (the server
 * applies its 0.35 / 0.35 / 0.30 defaults), or all three are filled and sum to
 * 1.0. A partial fill is rejected so the validated values always match what is
 * persisted.
 */
export function ideaTreeWeightsValid(draft: IdeaTreeSettingsDraft): boolean {
  const weights = [
    draft.assessorActivity.weight,
    draft.assessorStability.weight,
    draft.assessorSustainability.weight,
  ].map((value) => value.trim());
  const allEmpty = weights.every((value) => value === "");
  if (allEmpty) return true;
  const anyEmpty = weights.some((value) => value === "");
  if (anyEmpty) return false;
  const sum = weights.reduce((acc, value) => acc + Number(value), 0);
  return Number.isFinite(sum) && Math.abs(sum - 1) < 0.001;
}

export function IdeaTreeSettingsEditor({
  draft,
  onChange,
  onSave,
  saving,
  settings,
}: {
  draft: IdeaTreeSettingsDraft;
  onChange: (draft: IdeaTreeSettingsDraft) => void;
  onSave: () => void;
  saving: boolean;
  settings: IdeaTreeSettingsDetails;
}) {
  const { t } = useLocale();
  const weightsValid = ideaTreeWeightsValid(draft);
  const canSave = !saving && weightsValid;

  function updateAssessor(key: "assessorActivity" | "assessorStability" | "assessorSustainability", next: IdeaTreeAssessorDraft): void {
    onChange({ ...draft, [key]: next });
  }

  function renderAssessor(key: "assessorActivity" | "assessorStability" | "assessorSustainability", labelKey: MessageKey, config: IdeaTreeAssessorDraft): ReactNode {
    return <fieldset className="idea-tree-assessor" key={key}>
      <legend>{t(labelKey)}</legend>
      <label className="idea-tree-field">
        <span>{t("ideaTree.assessorPrompt" as MessageKey)}</span>
        <textarea
          onChange={(event) => updateAssessor(key, { ...config, systemPrompt: event.target.value })}
          rows={3}
          value={config.systemPrompt}
        />
      </label>
      <label className="idea-tree-field">
        <span>{t("ideaTree.scoringCriteria" as MessageKey)}</span>
        <textarea
          onChange={(event) => updateAssessor(key, { ...config, scoringCriteria: event.target.value })}
          rows={5}
          value={config.scoringCriteria}
        />
      </label>
      <label className="idea-tree-file-upload">
        <span>{t("ideaTree.uploadCriteria" as MessageKey)}</span>
        <input
          accept=".txt,.md,.json,.yaml,.yml"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
              const text = typeof reader.result === "string" ? reader.result : "";
              updateAssessor(key, { ...config, scoringCriteria: text });
            };
            reader.readAsText(file);
            event.target.value = "";
          }}
          type="file"
        />
      </label>
      <label className="idea-tree-field idea-tree-weight-field">
        <span>{t("ideaTree.weight" as MessageKey)}</span>
        <input
          max="1"
          min="0"
          onChange={(event) => updateAssessor(key, { ...config, weight: event.target.value })}
          step="0.01"
          type="number"
          value={config.weight}
        />
      </label>
    </fieldset>;
  }

  return <section aria-label={t("ideaTree.settings" as MessageKey)} className="idea-tree-settings">
    <div className="settings-detail-header">
      <span className="eyebrow">{t("settings.groups.idea-tree.label" as MessageKey)}</span>
      <h3>{t("ideaTree.settings" as MessageKey)}</h3>
      <p>{t("ideaTree.description" as MessageKey)}</p>
    </div>
    <h4 className="idea-tree-section-title">{t("ideaTree.defaults" as MessageKey)}</h4>
    <p className="config-note">{t("ideaTree.newResearchDefaults" as MessageKey)}</p>
    <div className="idea-tree-grid">
      {([['maxRounds', 1, 100], ['candidatesPerRound', 1, 20], ['maxTokens', 0, Number.MAX_SAFE_INTEGER], ['maxTokensPerCall', 256, 32768]] as const).map(([key, min, max]) => <label className="idea-tree-field" key={key}>
        <span>{t(`ideaTree.${key}` as MessageKey)}</span>
        <input type="number" min={min} max={max} value={draft[key]} onChange={event => onChange({...draft, [key]: event.target.value})} />
      </label>)}
      <label className="idea-tree-field">
        <span>{t("ideaTree.maxDepth" as MessageKey)}</span>
        <input
          max={20}
          min={1}
          onChange={(event) => onChange({ ...draft, maxDepth: event.target.value })}
          type="number"
          value={draft.maxDepth}
        />
      </label>
      <label className="idea-tree-field">
        <span>{t("ideaTree.maxNodes" as MessageKey)}</span>
        <input
          max={10000}
          min={2}
          onChange={(event) => onChange({ ...draft, maxNodes: event.target.value })}
          type="number"
          value={draft.maxNodes}
        />
      </label>
      <label className="idea-tree-field">
        <span>{t("ideaTree.maxSearchRounds" as MessageKey)}</span>
        <input
          max={10000}
          min={1}
          onChange={(event) => onChange({ ...draft, maxSearchRounds: event.target.value })}
          type="number"
          value={draft.maxSearchRounds}
        />
      </label>
      <label className="idea-tree-field">
        <span>{t("ideaTree.scoreDirection" as MessageKey)}</span>
        <select
          onChange={(event) => onChange({ ...draft, scoreDirection: event.target.value as "maximize" | "minimize" })}
          value={draft.scoreDirection}
        >
          <option value="maximize">{t("ideaTree.maximize" as MessageKey)}</option>
          <option value="minimize">{t("ideaTree.minimize" as MessageKey)}</option>
        </select>
      </label>
    </div>
    <h4 className="idea-tree-section-title">{t("ideaTree.prompts" as MessageKey)}</h4>
    <p className="config-note">{t("ideaTree.emptyMeansDefault" as MessageKey)}</p>
    <label className="idea-tree-field">
      <span>{t("ideaTree.designPrompt" as MessageKey)}</span>
      <textarea
        onChange={(event) => onChange({ ...draft, designSystemPrompt: event.target.value })}
        rows={4}
        value={draft.designSystemPrompt}
      />
    </label>
    <label className="idea-tree-field">
      <span>{t("ideaTree.aggregatorPrompt" as MessageKey)}</span>
      <textarea
        onChange={(event) => onChange({ ...draft, aggregatorSystemPrompt: event.target.value })}
        rows={4}
        value={draft.aggregatorSystemPrompt}
      />
    </label>
    <label className="idea-tree-field">
      <span>{t("ideaTree.propagatePrompt" as MessageKey)}</span>
      <textarea
        onChange={(event) => onChange({ ...draft, propagateInsightSystemPrompt: event.target.value })}
        rows={4}
        value={draft.propagateInsightSystemPrompt}
      />
    </label>
    <h4 className="idea-tree-section-title">{t("ideaTree.assessors" as MessageKey)}</h4>
    <div className="idea-tree-assessors">
      {renderAssessor("assessorActivity", "ideaTree.assessorActivity" as MessageKey, draft.assessorActivity)}
      {renderAssessor("assessorStability", "ideaTree.assessorStability" as MessageKey, draft.assessorStability)}
      {renderAssessor("assessorSustainability", "ideaTree.assessorSustainability" as MessageKey, draft.assessorSustainability)}
    </div>
    {!weightsValid ? <p className="workflow-error idea-tree-weight-error" role="status">{t("ideaTree.weightError" as MessageKey)}</p> : null}
    <div className="settings-actions">
      <button
        className="primary-button"
        disabled={!canSave}
        onClick={onSave}
        type="button"
      >
        {saving ? t("common.saving" as MessageKey) : t("common.save" as MessageKey)}
      </button>
      <span className="settings-source">{t("settings.groups.idea-tree.description" as MessageKey)}</span>
    </div>
  </section>;
}
