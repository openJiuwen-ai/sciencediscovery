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

/**
 * Pieces shared by the provider registry rows and the connect card: the
 * manual model form (state, parsing, catalog prefill, request building, and
 * the fields themselves) and the compact fact badges of one provider model.
 * Both surfaces register models the same way, so they read the same code.
 */

import type {
  CreateProviderModelRequest,
  ModelThinkingEffort,
  ProviderModelEntry,
  UserModelPricing,
} from "@sciencediscovery/schema";
import { lookupModelCatalog, resolveModelFacts } from "@sciencediscovery/schema";

import { ImageIcon, SparkleIcon } from "./icons.js";
import { useLocale } from "./i18n/index.js";

export interface ManualModelForm {
  contextWindow: string;
  efforts: string;
  label: string;
  maxOutputTokens: string;
  modelId: string;
  priceCached: string;
  priceCurrency: string;
  priceInput: string;
  priceOutput: string;
  vision: boolean;
}

export const EMPTY_MANUAL_MODEL: ManualModelForm = {
  contextWindow: "",
  efforts: "",
  label: "",
  maxOutputTokens: "",
  modelId: "",
  priceCached: "",
  priceCurrency: "",
  priceInput: "",
  priceOutput: "",
  vision: false,
};

const KNOWN_EFFORTS: readonly ModelThinkingEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Parse a comma-separated raw effort list ("low, high, max"), keeping only
 *  efforts the product knows. */
export function parseEffortList(value: string): ModelThinkingEffort[] {
  return value.split(",")
    .map((part) => part.trim())
    .filter((part): part is ModelThinkingEffort => KNOWN_EFFORTS.includes(part as ModelThinkingEffort));
}

function parseOptionalInt(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptionalNumber(value: string): number | undefined {
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function mergedFact<T>(remote: T | undefined, catalog: T | undefined): T | undefined {
  return remote !== undefined ? remote : catalog;
}

/** Exact-match a typed model ID against models.dev (alias-aware) and prefill
 *  every field the user has not filled yet. No match means no guessing: the
 *  form is returned unchanged apart from the ID itself. */
export function prefillManualFromCatalog(
  current: ManualModelForm,
  modelId: string,
  presetId: string | undefined,
): ManualModelForm {
  const catalog = lookupModelCatalog(modelId.trim(), presetId);
  const next = { ...current, modelId };
  if (!catalog) return next;
  return {
    ...next,
    label: current.label || catalog.label,
    vision: current.vision || catalog.vision === true,
    contextWindow: current.contextWindow || (catalog.contextWindow !== undefined ? String(catalog.contextWindow) : ""),
    maxOutputTokens: current.maxOutputTokens || (catalog.maxOutputTokens !== undefined ? String(catalog.maxOutputTokens) : ""),
    efforts: current.efforts || (catalog.thinking?.efforts?.length ? catalog.thinking.efforts.join(",") : ""),
    priceCurrency: current.priceCurrency || catalog.pricing?.currency || "",
    priceInput: current.priceInput || (catalog.pricing ? String(catalog.pricing.input) : ""),
    priceOutput: current.priceOutput || (catalog.pricing ? String(catalog.pricing.output) : ""),
    priceCached: current.priceCached || (catalog.pricing?.cachedInput !== undefined ? String(catalog.pricing.cachedInput) : ""),
  };
}

/** Turn the manual form (plus, for a discovered row, the listing entry) into
 *  the registration request. Facts carry only what the user stated; without
 *  an effort list the model simply omits thinking parameters. */
export function manualModelRequest(
  modelId: string,
  manual: ManualModelForm,
  entry?: ProviderModelEntry,
): CreateProviderModelRequest {
  const label = manual.label.trim() || entry?.displayName || entry?.catalog?.label;
  const vision = manual.vision || mergedFact(entry?.remote?.vision, entry?.catalog?.vision);
  const efforts = parseEffortList(manual.efforts);
  const contextWindow = parseOptionalInt(manual.contextWindow);
  const maxOutputTokens = parseOptionalInt(manual.maxOutputTokens);
  const priceInput = parseOptionalNumber(manual.priceInput);
  const priceOutput = parseOptionalNumber(manual.priceOutput);
  const priceCached = parseOptionalNumber(manual.priceCached);
  const pricing = priceInput !== undefined && priceOutput !== undefined
    ? {
        currency: (manual.priceCurrency.trim() || "USD") as UserModelPricing["currency"],
        input: priceInput,
        output: priceOutput,
        ...(priceCached !== undefined ? { cachedInput: priceCached } : {}),
      }
    : undefined;
  const facts = contextWindow !== undefined || maxOutputTokens !== undefined || pricing || efforts.length
    ? {
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(pricing ? { pricing } : {}),
        ...(efforts.length ? { thinkingEfforts: efforts } : {}),
      }
    : undefined;
  return {
    ...(label ? { label } : {}),
    model: modelId.trim(),
    ...(vision !== undefined ? { vision } : {}),
    ...(facts ? { facts } : {}),
  };
}

/** The manual registration form: exact model ID first (typing a catalog-known
 *  ID prefills the rest), then the optional facts. The same fields serve the
 *  registry row and the connect card so a model is described the same way
 *  wherever it is added. */
export function ManualModelFields({
  busy,
  form,
  onChange,
  onSubmit,
  presetId,
  submitLabel,
}: {
  busy: boolean;
  form: ManualModelForm;
  onChange: (next: ManualModelForm) => void;
  onSubmit: () => void;
  presetId: string | undefined;
  submitLabel: string;
}) {
  const { t } = useLocale();
  const update = (patch: Partial<ManualModelForm>) => onChange({ ...form, ...patch });
  return <div className="provider-manual-form">
    <label><span>{t("providers.models.manualId")}</span><input value={form.modelId} onChange={(event) => onChange(prefillManualFromCatalog(form, event.target.value, presetId))} placeholder={t("providers.models.manualPlaceholder")} /></label>
    <label><span>{t("providers.manual.label")}</span><input value={form.label} onChange={(event) => update({ label: event.target.value })} placeholder={t("providers.manual.labelPlaceholder")} /></label>
    <label><span>{t("providers.manual.context")}</span><input inputMode="numeric" value={form.contextWindow} onChange={(event) => update({ contextWindow: event.target.value })} placeholder="1000000" /></label>
    <label><span>{t("providers.manual.output")}</span><input inputMode="numeric" value={form.maxOutputTokens} onChange={(event) => update({ maxOutputTokens: event.target.value })} placeholder="131072" /></label>
    <label><span>{t("providers.manual.efforts")}</span><input value={form.efforts} onChange={(event) => update({ efforts: event.target.value })} placeholder={t("providers.manual.effortsPlaceholder")} /></label>
    <label className="provider-manual-vision"><input checked={form.vision} onChange={(event) => update({ vision: event.target.checked })} type="checkbox" /><span>{t("settings.visionCapable")}</span></label>
    <div className="provider-manual-price">
      <span className="provider-manual-price-title">{t("providers.manual.price")}</span>
      <label><span>{t("providers.manual.priceCurrency")}</span><input value={form.priceCurrency} onChange={(event) => update({ priceCurrency: event.target.value })} placeholder="USD" /></label>
      <label><span>{t("providers.manual.priceInput")}</span><input inputMode="decimal" value={form.priceInput} onChange={(event) => update({ priceInput: event.target.value })} placeholder="1.5" /></label>
      <label><span>{t("providers.manual.priceOutput")}</span><input inputMode="decimal" value={form.priceOutput} onChange={(event) => update({ priceOutput: event.target.value })} placeholder="3" /></label>
      <label><span>{t("providers.manual.priceCached")}</span><input inputMode="decimal" value={form.priceCached} onChange={(event) => update({ priceCached: event.target.value })} placeholder="0.2" /></label>
    </div>
    <button className="secondary-button provider-manual-submit" disabled={busy || !form.modelId.trim()} onClick={onSubmit} type="button">{submitLabel}</button>
  </div>;
}

/** Large token counts as integers: 1,000,000 → "1M", 200,000 → "200k". */
export function compactTokenCount(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** Compact facts as hover-labelled badges: context/output as 1M/200k, vision
 *  and thinking as icons, thinking levels as one group, price as
 *  input/output/cached with the per-million unit last. */
export function ModelRowFacts({ model }: { model: ProviderModelEntry }) {
  const resolved = resolveModelFacts(model);
  const contextWindow = resolved.contextWindow;
  const maxOutputTokens = resolved.maxOutputTokens;
  const vision = mergedFact(model.remote?.vision, model.catalog?.vision);
  const thinking = resolved.thinkingSupported ?? model.catalog?.thinking?.supported;
  // Effort levels are provider vocabulary: show the raw strings (the user's
  // declared list wins over the catalog), never translated labels.
  const efforts = model.user?.thinkingEfforts ?? model.catalog?.thinking?.efforts;
  const pricing = resolved.pricing;
  return <span className="provider-model-row-facts">
    <span className="fact">{compactTokenCount(contextWindow) ?? "?"} / {compactTokenCount(maxOutputTokens) ?? "?"}</span>
    <span className={vision ? "fact icon on" : "fact icon"}><ImageIcon size={12} />{vision === undefined ? "?" : vision ? "✓" : "—"}</span>
    <span className={thinking ? "fact icon on" : "fact icon"}>
      <SparkleIcon size={12} />{thinking === undefined ? "?" : thinking
        ? (efforts?.length ? efforts.join(" ") : "✓")
        : "—"}
    </span>
    <span className="fact">
      {pricing
        ? `${pricing.input} / ${pricing.output}${pricing.cachedInput !== undefined ? ` / ${pricing.cachedInput}` : ""} ${pricing.currency}/1M`
        : "?"}
    </span>
  </span>;
}
