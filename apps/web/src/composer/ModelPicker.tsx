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

import { useEffect, useRef, useState, type CSSProperties } from "react";

import type {
  ModelProfile,
  ModelProvider,
  ModelThinkingEffort,
  ModelThinkingMode,
} from "@sciencediscovery/schema";
import { lookupModelCatalog, resolveModelFacts } from "@sciencediscovery/schema";

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

/** Fixed-position hover popup placement: below the row, flipped above when
 *  there is no room; clamped into the viewport horizontally. Being `fixed`
 *  keeps it out of any scroll container, so the list height never changes. */
export function hoverPopupStyle(
  anchor: { bottom: number; left: number; top: number },
  width = 300,
  estimatedHeight = 240,
  viewport = { height: window.innerHeight, width: window.innerWidth },
): CSSProperties {
  const popupWidth = Math.min(width, viewport.width - 16);
  const flip = anchor.bottom + estimatedHeight > viewport.height;
  const left = Math.max(8, Math.min(anchor.left, viewport.width - popupWidth - 8));
  return flip
    ? { bottom: viewport.height - anchor.top + 4, left, position: "fixed", width: popupWidth }
    : { left, position: "fixed", top: anchor.bottom + 4, width: popupWidth };
}

/** Profile names are saved as "Provider · model label"; inside a provider
 *  group that prefix is noise, so rows show the model's own name. */
export function modelDisplayName(model: ModelProfile, provider?: ModelProvider): string {
  const prefix = provider ? `${provider.name} · ` : "";
  if (prefix && model.name.startsWith(prefix)) return model.name.slice(prefix.length);
  const separator = model.providerId ? model.name.indexOf(" · ") : -1;
  return separator >= 0 ? model.name.slice(separator + 3) : model.name;
}

function fullTokenCount(value: number | undefined, unknown: string): string {
  return value === undefined ? unknown : new Intl.NumberFormat().format(value);
}

/** Rich hover card for one model row in the conversation picker: everything
 *  the row abbreviates, with full numbers and raw effort levels. Rendered
 *  inside a pointer-events:none popup, so it never blocks the click. */
export function ModelPickerModelFacts({
  model,
  provider,
  style,
}: {
  model: ModelProfile;
  provider?: ModelProvider | undefined;
  style?: CSSProperties | undefined;
}) {
  const { t } = useLocale();
  const unknown = t("providers.metadata.unknown");
  const catalog = lookupModelCatalog(model.model, provider?.presetId);
  const resolved = resolveModelFacts({
    ...(catalog ? { catalog } : {}),
    ...(model.facts ? { user: model.facts } : {}),
  });
  const thinking = resolved.thinkingSupported ?? catalog?.thinking?.supported;
  const efforts = model.facts?.thinkingEfforts ?? catalog?.thinking?.efforts;
  const pricing = resolved.pricing;
  const origin = Object.values(resolved.origins).includes("user")
    ? t("providers.facts.originUser")
    : catalog ? t("providers.models.catalog") : unknown;
  return <div className="model-picker-popup" role="tooltip" {...(style ? { style } : {})}>
    <strong>{modelDisplayName(model, provider)}</strong>
    <code>{model.model}</code>
    <dl>
      <div><dt>{t("providers.metadata.context")}</dt><dd>{fullTokenCount(resolved.contextWindow, unknown)}</dd></div>
      <div><dt>{t("providers.metadata.output")}</dt><dd>{fullTokenCount(resolved.maxOutputTokens, unknown)}</dd></div>
      <div><dt>{t("providers.metadata.vision")}</dt><dd>{model.vision ? t("common.yes") : t("common.no")}</dd></div>
      <div><dt>{t("providers.metadata.thinking")}</dt><dd>{thinking === undefined ? unknown : thinking ? (efforts?.length ? efforts.join(" / ") : t("common.yes")) : t("common.no")}</dd></div>
      <div><dt>{t("providers.metadata.price")}</dt><dd>{pricing
        ? `${pricing.currency} ${pricing.input} / ${pricing.output}${pricing.cachedInput !== undefined ? ` / ${pricing.cachedInput}` : ""} · ${t("providers.metadata.perMillion")}`
        : unknown}</dd></div>
      <div><dt>{t("providers.facts.source")}</dt><dd>{origin}</dd></div>
    </dl>
  </div>;
}

export function thinkingChoiceLabelKey(choice: ThinkingChoice): MessageKey | undefined {
  if (choice.value === "off") return "composer.modelPicker.off";
  if (choice.effort) return undefined;
  return `settings.thinkingMode.${choice.mode}`;
}

/** Visible label for one stop: effort levels stay in provider vocabulary
 *  (raw "low"/"high"/"max"), while off and model default are localized. */
export function thinkingChoiceLabel(choice: ThinkingChoice, t: (key: MessageKey) => string): string {
  if (choice.effort) return choice.effort;
  const key = thinkingChoiceLabelKey(choice);
  return key ? t(key) : choice.value;
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
function ModelPickerRow({
  active,
  model,
  onSelect,
  provider,
}: {
  active: boolean;
  model: ModelProfile;
  onSelect: (modelId: string) => void;
  provider?: ModelProvider | undefined;
}) {
  const { t } = useLocale();
  const [anchor, setAnchor] = useState<DOMRect>();
  return <li
    className="model-picker-row-wrap"
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAnchor(undefined);
    }}
    onFocus={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
    onMouseEnter={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
    onMouseLeave={() => setAnchor(undefined)}
  >
    <button
      aria-selected={active}
      className={active ? "model-picker-row active" : "model-picker-row"}
      onClick={() => onSelect(model.id)}
      role="option"
      type="button"
    >
      <span className="model-picker-row-text">
        <strong>{modelDisplayName(model, provider)}</strong>
        <code>{model.model}</code>
      </span>
      {model.vision ? <span className="model-badge">{t("settings.visionCapable")}</span> : null}
    </button>
    {anchor ? <ModelPickerModelFacts model={model} {...(provider ? { provider } : {})} style={hoverPopupStyle(anchor)} /> : null}
  </li>;
}

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
  const activeProvider = activeModel?.providerId
    ? providers.find((provider) => provider.id === activeModel.providerId)
    : undefined;
  const stops = thinkingChoiceOptions(controls);
  const currentValue = thinkingChoiceValue(thinkingMode, thinkingEffort, stops);
  const currentIndex = Math.max(0, stops.findIndex((stop) => stop.value === currentValue));

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
      <span className="model-picker-trigger-name">{activeModel ? modelDisplayName(activeModel, activeProvider) : t("composer.noModel")}</span>
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
            {group.models.map((model) => <ModelPickerRow
              active={model.id === activeModelId}
              key={model.id}
              model={model}
              onSelect={onSelect}
              {...(group.provider ? { provider: group.provider } : {})}
            />)}
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
          <div className="model-picker-stops-row">
            <div aria-label={t("composer.modelPicker.thinkingAria")} className="model-picker-stops" role="radiogroup">
              {stops.map((stop, index) => <button
                aria-checked={index === currentIndex}
                className={index === currentIndex ? "model-picker-stop active" : "model-picker-stop"}
                disabled={disabled}
                key={stop.value}
                onClick={() => applyStop(index)}
                role="radio"
                type="button"
              >{thinkingChoiceLabel(stop, t)}</button>)}
            </div>
          </div>
          {controls.legacyBudget ? <small className="model-picker-note">{t("composer.thinkingLegacyNotice")}</small> : null}
        </> : <small className="model-picker-note">{t("composer.modelPicker.thinkingUnsupported")}</small>}
      </div> : null}
    </div> : null}
  </div>;
}
