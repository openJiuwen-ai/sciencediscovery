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

import { useEffect, useRef, useState } from "react";

import type {
  ModelProfile,
  ModelProvider,
  ModelThinkingEffort,
  ModelThinkingMode,
} from "@sciencediscovery/schema";

import { useLocale, type MessageKey } from "../i18n/index.js";
import type { ModelThinkingControls, ThinkingChoice } from "../modelThinking.js";
import { thinkingChoiceOptions, thinkingChoiceValue } from "../modelThinking.js";

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

export function thinkingChoiceLabelKey(choice: ThinkingChoice): MessageKey {
  if (choice.value === "off") return "composer.modelPicker.off";
  if (choice.effort) return `settings.thinkingEffort.${choice.effort}`;
  return `settings.thinkingMode.${choice.mode}`;
}

/** Inverse of the combined-control value encoding used by
 *  `thinkingChoiceOptions` ("off" | "auto" | "on" | "effort:<level>"). */
export function parseThinkingChoice(value: string): { effort?: ModelThinkingEffort; mode?: ModelThinkingMode } {
  if (value === "off") return { mode: "disabled" };
  if (value === "auto") return { mode: "auto" };
  if (value === "on") return { mode: "enabled" };
  if (value.startsWith("effort:")) return { effort: value.slice("effort:".length) as ModelThinkingEffort, mode: "enabled" };
  return {};
}

/** Small connector-style popover for picking the conversation model, with a
 *  thinking control as a joined row of labelled stop buttons: off (only when
 *  it can be disabled) → model default (auto) → efforts from weakest to
 *  strongest. Models without thinking control get no stop row. */
export function ModelPicker({
  activeModelId,
  controls,
  disabled = false,
  models,
  onOpenSettings,
  onSelect,
  onThinkingChange,
  providers,
  thinkingEffort,
  thinkingMode,
  thinkingSummary,
}: {
  activeModelId?: string | undefined;
  controls: ModelThinkingControls;
  disabled?: boolean;
  models: ModelProfile[];
  onOpenSettings: () => void;
  onSelect: (modelId: string) => void;
  onThinkingChange: (update: { thinkingEffort?: ModelThinkingEffort; thinkingMode?: ModelThinkingMode }) => void;
  providers: ModelProvider[];
  thinkingEffort: ModelThinkingEffort;
  thinkingMode: ModelThinkingMode;
  thinkingSummary?: string | undefined;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const groups = groupModelsByProvider(models, providers);
  const activeModel = models.find((model) => model.id === activeModelId);
  const stops = thinkingChoiceOptions(controls);
  const currentValue = thinkingChoiceValue(thinkingMode, thinkingEffort, stops);
  const currentIndex = Math.max(0, stops.findIndex((stop) => stop.value === currentValue));
  const currentLabel = stops.length ? t(thinkingChoiceLabelKey(stops[currentIndex]!)) : "";

  function applyStop(index: number): void {
    const stop = stops[index];
    if (!stop) return;
    onThinkingChange(stop.effort
      ? { thinkingEffort: stop.effort, thinkingMode: "enabled" }
      : { thinkingMode: stop.mode });
  }

  return <div className="model-picker" ref={rootRef}>
    <button
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={t("composer.modelAria")}
      className="model-picker-trigger"
      disabled={disabled || !models.length}
      onClick={() => setOpen((current) => !current)}
      type="button"
    >
      <i className="live-dot" />
      <span className="model-picker-trigger-name">{activeModel ? activeModel.name : t("composer.noModel")}</span>
      {thinkingSummary ? <small className="model-picker-trigger-thinking">{thinkingSummary}</small> : null}
    </button>
    {open ? <div aria-label={t("composer.modelPicker.title")} className="model-picker-popover" role="dialog">
      <div className="model-picker-heading">
        <strong>{t("composer.modelPicker.title")}</strong>
        <span>{t("composer.modelPicker.count", { total: models.length })}</span>
      </div>
      {groups.length ? <div className="model-picker-groups">
        {groups.map((group) => <div className="model-picker-group" key={group.provider?.id ?? "other"}>
          <h4>{group.provider ? group.provider.name : t("composer.modelPicker.otherGroup")}</h4>
          <ul>
            {group.models.map((model) => <li key={model.id}>
              <button
                aria-selected={model.id === activeModelId}
                className={model.id === activeModelId ? "model-picker-row active" : "model-picker-row"}
                onClick={() => onSelect(model.id)}
                role="option"
                type="button"
              >
                <span className="model-picker-row-text">
                  <strong>{model.name}</strong>
                  <code>{model.model}</code>
                </span>
                {model.vision ? <span className="model-badge">{t("settings.visionCapable")}</span> : null}
              </button>
            </li>)}
          </ul>
        </div>)}
      </div> : <div className="model-picker-empty">
        <p>{t("composer.modelPicker.empty")}</p>
        <button className="primary-button" onClick={() => {
          setOpen(false);
          onOpenSettings();
        }} type="button">{t("composer.modelPicker.openSettings")}</button>
      </div>}
      {activeModel ? <div className="model-picker-thinking">
        {stops.length ? <>
          <div className="model-picker-slider-label">
            <span>{t("composer.modelPicker.thinking")}</span>
            <strong aria-live="polite">{currentLabel}</strong>
          </div>
          <div aria-label={t("composer.modelPicker.thinkingAria")} className="model-picker-stops" role="radiogroup">
            {stops.map((stop, index) => <button
              aria-checked={index === currentIndex}
              className={index === currentIndex ? "model-picker-stop active" : "model-picker-stop"}
              disabled={disabled}
              key={stop.value}
              onClick={() => applyStop(index)}
              role="radio"
              type="button"
            >{t(thinkingChoiceLabelKey(stop))}</button>)}
          </div>
          {controls.legacyBudget ? <small className="model-picker-note">{t("composer.thinkingLegacyNotice")}</small> : null}
        </> : <small className="model-picker-note">{t("composer.modelPicker.thinkingUnsupported")}</small>}
      </div> : null}
    </div> : null}
  </div>;
}
