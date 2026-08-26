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

import { useEffect } from "react";

import type {
  ModelProfile,
  ModelProvider,
  ModelThinkingEffort,
  ModelThinkingMode,
} from "@sciencediscovery/schema";

import { CloseIcon } from "../icons.js";
import { useLocale } from "../i18n/index.js";
import type { ModelThinkingControls } from "../modelThinking.js";

/** One entry of the combined thinking control: the off switch and the effort
 *  list live in a single select, so a model that cannot turn thinking off
 *  (e.g. Kimi K3) simply has no "off" entry. */
export interface ThinkingChoice {
  effort?: ModelThinkingEffort;
  mode: ModelThinkingMode;
  value: string;
}

export function thinkingChoiceOptions(controls: ModelThinkingControls): ThinkingChoice[] {
  if (!controls.supported) return [];
  const options: ThinkingChoice[] = [];
  if (controls.modes.includes("disabled")) options.push({ mode: "disabled", value: "off" });
  if (controls.modes.includes("auto")) options.push({ mode: "auto", value: "auto" });
  if (controls.efforts.length) {
    for (const effort of controls.efforts) options.push({ effort, mode: "enabled", value: `effort:${effort}` });
  } else if (controls.modes.includes("enabled")) {
    options.push({ mode: "enabled", value: "on" });
  }
  return options;
}

export function thinkingChoiceValue(
  mode: ModelThinkingMode,
  effort: ModelThinkingEffort,
  options: readonly ThinkingChoice[],
): string {
  if (mode === "enabled") {
    const byEffort = options.find((option) => option.value === `effort:${effort}`);
    if (byEffort) return byEffort.value;
    if (options.some((option) => option.value === "on")) return "on";
  } else {
    const value = mode === "disabled" ? "off" : "auto";
    if (options.some((option) => option.value === value)) return value;
  }
  return options[0]?.value ?? "auto";
}

export interface ModelPickerGroup {
  models: ModelProfile[];
  provider?: ModelProvider;
}

/** Group configured models by their provider, keeping the registry order;
 *  profiles without a matching provider land in a trailing "other" group. */
export function groupModelsByProvider(
  models: readonly ModelProfile[],
  providers: readonly ModelProvider[],
): ModelPickerGroup[] {
  const groups: ModelPickerGroup[] = [];
  for (const provider of providers) {
    const owned = models.filter((model) => model.providerId === provider.id);
    if (owned.length) groups.push({ models: owned, provider });
  }
  const rest = models.filter((model) => !providers.some((provider) => provider.id === model.providerId));
  if (rest.length) groups.push({ models: rest });
  return groups;
}

export function ModelPickerDialog({
  activeModelId,
  controls,
  disabled = false,
  models,
  onClose,
  onOpenSettings,
  onSelect,
  onThinkingChange,
  providers,
  thinkingEffort,
  thinkingMode,
}: {
  activeModelId?: string | undefined;
  controls: ModelThinkingControls;
  disabled?: boolean;
  models: ModelProfile[];
  onClose: () => void;
  onOpenSettings: () => void;
  onSelect: (modelId: string) => void;
  onThinkingChange: (update: { thinkingEffort?: ModelThinkingEffort; thinkingMode?: ModelThinkingMode }) => void;
  providers: ModelProvider[];
  thinkingEffort: ModelThinkingEffort;
  thinkingMode: ModelThinkingMode;
}) {
  const { t } = useLocale();
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const groups = groupModelsByProvider(models, providers);
  const activeModel = models.find((model) => model.id === activeModelId);
  const options = thinkingChoiceOptions(controls);
  const choice = thinkingChoiceValue(thinkingMode, thinkingEffort, options);

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section aria-label={t("composer.modelPicker.title")} aria-modal="true" className="config-panel model-picker-dialog" role="dialog">
      <div className="config-header">
        <div><h2>{t("composer.modelPicker.title")}</h2><small>{t("composer.modelPicker.help")}</small></div>
        <button aria-label={t("composer.modelPicker.close")} className="icon-button" onClick={onClose} title={t("composer.modelPicker.close")} type="button"><CloseIcon size={20} /></button>
      </div>
      <div className="model-picker-body">
        {groups.length ? groups.map((group) => <div className="model-picker-group" key={group.provider?.id ?? "other"}>
          <h4>{group.provider ? group.provider.name : t("composer.modelPicker.otherGroup")}</h4>
          <div className="model-picker-group-list" role="listbox" aria-label={group.provider ? group.provider.name : t("composer.modelPicker.otherGroup")}>
            {group.models.map((model) => <button
              aria-selected={model.id === activeModelId}
              className={model.id === activeModelId ? "model-picker-row active" : "model-picker-row"}
              disabled={disabled}
              key={model.id}
              onClick={() => onSelect(model.id)}
              role="option"
              type="button"
            >
              <span className="model-picker-row-text">
                <strong>{model.name}</strong>
                <code>{model.model}</code>
              </span>
              <span className="model-picker-row-badges">
                {model.vision ? <span className="model-badge">{t("settings.visionCapable")}</span> : null}
                {model.id === activeModelId ? <span className="model-badge current">{t("composer.modelPicker.current")}</span> : null}
              </span>
            </button>)}
          </div>
        </div>) : <div className="model-picker-empty">
          <p>{t("composer.modelPicker.empty")}</p>
          <button className="primary-button" onClick={onOpenSettings} type="button">{t("composer.modelPicker.openSettings")}</button>
        </div>}
        {activeModel ? <div className="model-picker-thinking">
          {controls.supported && options.length ? <label>
            <span>{t("composer.modelPicker.thinking")}</span>
            <select
              aria-label={t("composer.modelPicker.thinkingAria")}
              disabled={disabled}
              onChange={(event) => {
                const selected = options.find((option) => option.value === event.target.value);
                if (!selected) return;
                onThinkingChange(selected.effort
                  ? { thinkingEffort: selected.effort, thinkingMode: "enabled" }
                  : { thinkingMode: selected.mode });
              }}
              value={choice}
            >
              {options.map((option) => <option key={option.value} value={option.value}>
                {option.value === "off"
                  ? t("composer.modelPicker.off")
                  : option.effort
                    ? t(`settings.thinkingEffort.${option.effort}`)
                    : t(`settings.thinkingMode.${option.mode}`)}
              </option>)}
            </select>
          </label> : <small className="model-editor-hint">{t("composer.modelPicker.thinkingUnsupported")}</small>}
          {controls.legacyBudget ? <small className="model-editor-hint">{t("composer.thinkingLegacyNotice")}</small> : null}
        </div> : null}
      </div>
    </section>
  </div>;
}
