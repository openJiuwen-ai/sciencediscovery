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

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import type {
  ModelApiProtocol,
  ModelApiVariant,
  ModelCatalogDetails,
  ModelCatalogEntry,
  ModelDiscoveryStrategy,
  ModelThinkingEffort,
  ModelProfile,
  ModelProvider,
  ModelProviderPreset,
  ModelProviderPresetId,
  ProviderModelEntry,
  ProviderModelList,
  ProxyPolicy,
  ProxySettingsDetails,
  UserModelPricing,
} from "@sciencediscovery/schema";
import {
  DEFAULT_MODEL_API_VARIANT,
  DEFAULT_MODEL_DISCOVERY,
  lookupModelCatalog,
  MODEL_API_VARIANTS,
  resolveModelFacts,
} from "@sciencediscovery/schema";

import type { SettingsApiClient } from "./api/settings.js";
import { ImageIcon, SparkleIcon } from "./icons.js";
import { ModelConnectivityButton } from "./ModelConnectivityButton.js";
import { ProxyPolicySelect } from "./ProxySettingsEditor.js";
import { useLocale } from "./i18n/index.js";

interface ProviderDraft {
  apiProtocol: ModelApiProtocol;
  apiToken: string;
  apiVariant: ModelApiVariant;
  baseUrl: string;
  modelDiscovery: ModelDiscoveryStrategy;
  name: string;
  presetId?: ModelProviderPresetId;
  providerId?: string;
  proxyPolicy: ProxyPolicy;
  removeToken: boolean;
  tokenOptional: boolean;
}

function presetDraft(preset: ModelProviderPreset): ProviderDraft {
  return {
    apiProtocol: preset.apiProtocol,
    apiToken: "",
    apiVariant: preset.apiVariant,
    baseUrl: preset.baseUrl,
    modelDiscovery: preset.modelDiscovery,
    name: preset.name,
    presetId: preset.id,
    proxyPolicy: "inherit",
    removeToken: false,
    tokenOptional: preset.tokenOptional === true,
  };
}

function providerDraft(provider: ModelProvider): ProviderDraft {
  return {
    apiProtocol: provider.apiProtocol,
    apiToken: "",
    apiVariant: provider.apiVariant,
    baseUrl: provider.baseUrl,
    modelDiscovery: provider.modelDiscovery,
    name: provider.name,
    presetId: provider.presetId,
    providerId: provider.id,
    proxyPolicy: provider.proxyPolicy,
    removeToken: false,
    tokenOptional: provider.tokenOptional,
  };
}

const CUSTOM_PROVIDER: ProviderDraft = {
  apiProtocol: "openai-chat-completions",
  apiToken: "",
  apiVariant: "openai",
  baseUrl: "",
  modelDiscovery: "openai-models",
  name: "",
  proxyPolicy: "inherit",
  removeToken: false,
  tokenOptional: false,
};

function mergedFact<T>(remote: T | undefined, catalog: T | undefined): T | undefined {
  return remote !== undefined ? remote : catalog;
}

function tokenCount(value: number | undefined, unknown: string): string {
  return value === undefined ? unknown : new Intl.NumberFormat().format(value);
}

export function canonicalSourceUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    return parsed.toString();
  } catch {
    return value.replace(/\/+$/u, "");
  }
}

export function sourceDate(value: string): string {
  const match = value.match(/^\d{4}-\d{2}-\d{2}/u);
  return match?.[0] ?? value;
}

export function providerOperationError(
  reason: unknown,
  fallback: string,
  referencedProviderMessage: string,
): string {
  const detail = reason instanceof Error ? reason.message : "";
  if (detail.includes("Provider models are referenced by runtime settings")) {
    return referencedProviderMessage;
  }
  return detail ? `${fallback}: ${detail}` : fallback;
}

export interface ProviderModelSettingsHandle {
  hasUnsavedDraft: () => boolean;
  saveDraft: () => Promise<boolean>;
}

interface ProviderListingRequest {
  providerId: string;
  sequence: number;
}

export function createProviderListingRequestGuard() {
  let sequence = 0;
  return {
    begin(providerId: string): ProviderListingRequest {
      sequence += 1;
      return { providerId, sequence };
    },
    invalidate(): void {
      sequence += 1;
    },
    isCurrent(request: ProviderListingRequest, providerId: string): boolean {
      return request.sequence === sequence && request.providerId === providerId;
    },
  };
}

function draftFingerprint(draft: ProviderDraft | undefined): string {
  return draft ? JSON.stringify(draft) : "";
}

export function PriceSummary({ model }: { model: ProviderModelEntry }) {
  const { t } = useLocale();
  const pricing = model.remote?.pricing ?? model.catalog?.pricing;
  if (!pricing) return <span>{t("providers.metadata.unknown")}</span>;
  if (pricing.periods?.length) {
    return <span className="provider-model-price-periods">
      {pricing.periods.map((period) => <span key={period.id}>
        {t(`providers.metadata.pricePeriod.${period.id}`)}: {pricing.currency} {period.input} / {period.output}
        {period.cachedInput !== undefined ? ` · ${t("providers.metadata.cachedInput")} ${period.cachedInput}` : ""}
        {` · ${t("providers.metadata.perMillion")} · ${period.schedule.kind === "weekdays"
          ? t("providers.metadata.priceSchedule.weekdays", {
              intervals: period.schedule.intervals.map(({ end, start }) => `${start}–${end}`).join(", "),
            })
          : t("providers.metadata.priceSchedule.remainder")}`}
      </span>)}
    </span>;
  }
  return <span>
    {pricing.currency} {pricing.input} / {pricing.output} · {t("providers.metadata.perMillion")}
    {pricing.cachedInput !== undefined ? ` · ${t("providers.metadata.cachedInput")} ${pricing.cachedInput}` : ""}
  </span>;
}

/** Added models first (they are what the user acts on), then alphabetical. */
export function sortProviderModels(entries: readonly ProviderModelEntry[]): ProviderModelEntry[] {
  return [...entries].toSorted((left, right) =>
    Number(Boolean(right.profileId)) - Number(Boolean(left.profileId))
    || (left.displayName ?? left.catalog?.label ?? left.id).localeCompare(right.displayName ?? right.catalog?.label ?? right.id));
}

/** The inline table is the union of already-added profiles and the pulled
 *  listing: an added model always keeps its row (and sorts first), listing
 *  entries not yet added follow. This is what keeps a manually registered
 *  model visible after save/refresh even when discovery returns nothing
 *  (manual strategy with no curated suggestions). */
export function mergeProviderModelRows(
  listingModels: readonly ProviderModelEntry[] | undefined,
  addedProfiles: readonly ModelProfile[],
  provider: ModelProvider,
): ProviderModelEntry[] {
  const byId = new Map<string, ProviderModelEntry>();
  for (const profile of addedProfiles) {
    const catalog = lookupModelCatalog(profile.model, provider.presetId);
    byId.set(profile.model, {
      id: profile.model,
      displayName: profile.name,
      profileId: profile.id,
      // The profile's vision is itself a user decision; surface it like a
      // reported fact so the badge matches what runs will actually get.
      remote: { vision: profile.vision },
      ...(profile.facts ? { user: profile.facts } : {}),
      ...(catalog ? { catalog } : {}),
    });
  }
  for (const entry of listingModels ?? []) {
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, entry);
      continue;
    }
    // The listing describes the vendor's model; the profile row carries what
    // this installation decided about it. Neither replaces the other. A fact
    // the user stated has to survive the moment a listing row for the same id
    // arrives — otherwise adding a model to a provider that already listed its
    // models would blank the hover card until the next refresh.
    const vision = existing.remote?.vision ?? entry.remote?.vision;
    const remote = { ...entry.remote, ...(vision !== undefined ? { vision } : {}) };
    byId.set(entry.id, {
      ...entry,
      catalog: entry.catalog ?? existing.catalog,
      displayName: entry.displayName ?? existing.displayName,
      profileId: entry.profileId ?? existing.profileId,
      ...(Object.keys(remote).length ? { remote } : {}),
      // The saved profile is the fresher copy: it is what the add just wrote.
      ...(existing.user ?? entry.user ? { user: existing.user ?? entry.user } : {}),
    });
  }
  return sortProviderModels([...byId.values()]);
}

/** Profiles are stored as "Provider · model label". The provider table already
 *  supplies that context, so only the model-owned part belongs in the row. */
export function providerModelDisplayName(model: ProviderModelEntry, provider: ModelProvider): string {
  if (model.catalog?.label) return model.catalog.label;
  const name = model.displayName ?? model.id;
  const prefix = `${provider.name} · `;
  if (name.startsWith(prefix)) return name.slice(prefix.length);
  const separator = model.profileId ? name.indexOf(" · ") : -1;
  return separator >= 0 ? name.slice(separator + 3) : name;
}

/** Place row facts in viewport coordinates and flip the card above bottom
 *  rows so the complete card remains inside the viewport. The rendered card
 *  is portalled to document.body; fixed positioning alone cannot escape the
 *  settings dialog's backdrop-filter containing block and overflow chain. */
export function providerModelPopupStyle(
  anchor: { bottom: number; left: number; top: number },
  width = 320,
  estimatedHeight = 240,
  viewport = { height: window.innerHeight, width: window.innerWidth },
): CSSProperties {
  const popupWidth = Math.min(width, viewport.width - 16);
  const left = Math.max(8, Math.min(anchor.left, viewport.width - popupWidth - 8));
  const flip = anchor.bottom + estimatedHeight > viewport.height;
  return flip
    ? { bottom: viewport.height - anchor.top + 4, left, position: "fixed", width: popupWidth }
    : { left, position: "fixed", top: anchor.bottom + 4, width: popupWidth };
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
function ModelRowFacts({ model }: { model: ProviderModelEntry }) {
  const { t } = useLocale();
  const unknown = t("providers.metadata.unknown");
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

/** Rich hover card for one provider model row: everything the compact badges
 *  abbreviate, with full numbers and the fact's origin. Replaces native
 *  `title` tooltips. */
function ModelRowPopup({
  model,
  provider,
  style,
}: {
  model: ProviderModelEntry;
  provider: ModelProvider;
  style?: CSSProperties | undefined;
}) {
  const { t } = useLocale();
  const unknown = t("providers.metadata.unknown");
  const resolved = resolveModelFacts(model);
  const vision = mergedFact(model.remote?.vision, model.catalog?.vision);
  const thinking = resolved.thinkingSupported ?? model.catalog?.thinking?.supported;
  const efforts = model.user?.thinkingEfforts ?? model.catalog?.thinking?.efforts;
  const pricing = resolved.pricing;
  // Any fact the user stated makes this card theirs, not just a context window
  // or a price; the conversation picker already reads it this way.
  const origin = Object.values(resolved.origins).includes("user")
    ? t("providers.facts.originUser")
    : model.remote ? t("providers.models.remote") : t("providers.models.catalog");
  return <div className="provider-model-popup" role="tooltip" {...(style ? { style } : {})}>
    <strong>{providerModelDisplayName(model, provider)}</strong>
    <code>{model.id}</code>
    <dl>
      <div><dt>{t("providers.metadata.context")}</dt><dd>{tokenCount(resolved.contextWindow, unknown)}</dd></div>
      <div><dt>{t("providers.metadata.output")}</dt><dd>{tokenCount(resolved.maxOutputTokens, unknown)}</dd></div>
      <div><dt>{t("providers.metadata.vision")}</dt><dd>{vision === undefined ? unknown : vision ? t("common.yes") : t("common.no")}</dd></div>
      <div><dt>{t("providers.metadata.thinking")}</dt><dd>{thinking === undefined ? unknown : thinking ? (efforts?.length ? efforts.join(" / ") : t("common.yes")) : t("common.no")}</dd></div>
      <div><dt>{t("providers.metadata.price")}</dt><dd>{pricing
        ? `${pricing.currency} ${pricing.input} / ${pricing.output}${pricing.cachedInput !== undefined ? ` / ${pricing.cachedInput}` : ""} · ${t("providers.metadata.perMillion")}`
        : unknown}</dd></div>
      <div><dt>{t("providers.facts.source")}</dt><dd>{origin}</dd></div>
    </dl>
  </div>;
}

function ProviderModelRow({
  busy,
  model,
  onAddModel,
  onDeleteModel,
  provider,
}: {
  busy: boolean;
  model: ProviderModelEntry;
  onAddModel: () => void;
  onDeleteModel: (profileId: string) => void;
  provider: ModelProvider;
}) {
  const { t } = useLocale();
  const [anchor, setAnchor] = useState<DOMRect>();
  return <div
    className="provider-model-row"
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAnchor(undefined);
    }}
    onFocus={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
    onMouseEnter={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
    onMouseLeave={() => setAnchor(undefined)}
    role="row"
  >
    <span className="provider-model-cell-name">
      <strong>{providerModelDisplayName(model, provider)}</strong>
      <code>{model.id}</code>
    </span>
    <ModelRowFacts model={model} />
    {anchor && typeof document !== "undefined"
      ? createPortal(
        <ModelRowPopup model={model} provider={provider} style={providerModelPopupStyle(anchor)} />,
        document.body,
      )
      : null}
    {model.profileId
      ? <button className="danger-button compact-button" disabled={busy} onClick={() => onDeleteModel(model.profileId!)} type="button">{t("common.delete")}</button>
      : <button className="secondary-button compact-button" disabled={busy} onClick={onAddModel} type="button">{t("providers.models.add")}</button>}
  </div>;
}

/** The model catalog header: when the shared metadata was last updated and a
 *  way to update it now. Refreshing only replaces the catalog, never the
 *  provider or model form the user may be part-way through. */
export function ModelCatalogStatus({ catalog, client, onCatalogChange, onError, onNotice }: {
  catalog?: ModelCatalogDetails;
  client: SettingsApiClient;
  onCatalogChange?: (details: ModelCatalogDetails) => void;
  onError: (message: string) => void;
  onNotice: (message: string, detail?: string) => void;
}) {
  const { t } = useLocale();
  const [refreshing, setRefreshing] = useState(false);
  const snapshot = catalog?.snapshot;

  async function refresh(): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const next = await client.refreshModelCatalog();
      onCatalogChange?.(next);
      onNotice(t("providers.catalog.notice.refreshed"), next.snapshot
        ? new Date(next.snapshot.fetchedAt).toLocaleString()
        : undefined);
    } catch (reason) {
      // The server keeps serving the snapshot it already had, so say that
      // rather than leaving the user to guess whether the data is now gone.
      const detail = reason instanceof Error ? reason.message : "";
      onError(detail ? `${t("providers.catalog.refreshFailed")}: ${detail}` : t("providers.catalog.refreshFailed"));
    } finally {
      setRefreshing(false);
    }
  }

  return <section className="model-catalog-status" aria-label={t("providers.catalog.title")}>
    <span className="model-catalog-line">
      <strong>{t("providers.catalog.title")}</strong>
      <small>{t("providers.catalog.source")}</small>
      <small>{snapshot
        ? t(`providers.catalog.updated.${snapshot.origin}`, { time: new Date(snapshot.fetchedAt).toLocaleString() })
        : t("providers.catalog.missing")}</small>
    </span>
    <button
      className="secondary-button compact-button"
      disabled={refreshing}
      onClick={() => void refresh()}
      type="button"
    >{refreshing ? t("providers.catalog.refreshing") : t("providers.catalog.refresh")}</button>
  </section>;
}

interface ListingState {
  error?: string;
  list?: ProviderModelList;
  loading: boolean;
}

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

const EMPTY_MANUAL_MODEL: ManualModelForm = {
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


export function ProviderRow({
  addedProfiles,
  busy,
  editorPanel,
  expanded,
  listing,
  onAddModel,
  onDeleteModel,
  onEdit,
  onRefresh,
  onToggle,
  provider,
  testModel,
}: {
  addedProfiles: ModelProfile[];
  busy: boolean;
  editorPanel?: ReactNode;
  expanded: boolean;
  listing?: ListingState | undefined;
  onAddModel: (providerId: string, modelId: string, entry: ProviderModelEntry | undefined, manual: ManualModelForm) => Promise<boolean>;
  onDeleteModel: (providerId: string, modelId: string, profileId: string) => Promise<boolean>;
  onEdit: (provider: ModelProvider) => void;
  onRefresh: (providerId: string) => void;
  onToggle: (providerId: string) => void;
  provider: ModelProvider;
  testModel: SettingsApiClient["testModel"];
}) {
  const { t } = useLocale();
  const [manual, setManual] = useState<ManualModelForm>({ ...EMPTY_MANUAL_MODEL });
  const [manualOpen, setManualOpen] = useState(false);
  const [testModelId, setTestModelId] = useState("");
  const rows = mergeProviderModelRows(listing?.list?.models, addedProfiles, provider);
  // The total counts the same union the table shows, so the count, the table,
  // and the test dropdown never disagree.
  const total = listing?.list ? rows.length : undefined;
  const ready = provider.hasApiToken || provider.tokenOptional;
  const testProfile = addedProfiles.find((profile) => profile.id === testModelId) ?? addedProfiles[0];

  async function submitManual(): Promise<void> {
    const added = await onAddModel(provider.id, manual.modelId, undefined, manual);
    if (added) {
      setManual({ ...EMPTY_MANUAL_MODEL });
      setManualOpen(false);
    }
  }

  function changeManualId(value: string): void {
    setManual((current) => prefillManualFromCatalog(current, value, provider.presetId));
  }

  return <div className={expanded ? "provider-row expanded" : "provider-row"}>
    <button
      aria-expanded={expanded}
      className="provider-row-summary"
      onClick={() => onToggle(provider.id)}
      type="button"
    >
      <span
        aria-label={ready ? t("providers.status.ready") : t("providers.status.missingToken")}
        className={ready ? "model-status" : "model-status missing"}
        role="img"
        title={ready ? t("providers.status.ready") : t("providers.status.missingToken")}
      />
      <span className="provider-row-name"><strong>{provider.name}</strong><small>{provider.baseUrl}</small></span>
      <span className="provider-row-count">{listing?.loading
        ? t("providers.configured.loading")
        : total === undefined
          ? t("providers.configured.addedOnly", { added: addedProfiles.length })
          : t("providers.configured.counts", { added: addedProfiles.length, total })}</span>
      <em>{provider.presetId ? t("providers.kind.builtIn") : t("providers.kind.custom")}</em>
    </button>
    {expanded ? <div className="provider-row-detail">
      <div className="provider-row-actions">
        <button className="secondary-button compact-button" onClick={() => onEdit(provider)} type="button">{t("providers.edit")}</button>
        <button className="secondary-button compact-button" disabled={busy || listing?.loading} onClick={() => onRefresh(provider.id)} type="button">{listing?.loading ? t("common.loading") : t("providers.models.refresh")}</button>
        {addedProfiles.length && testProfile ? <span className="provider-row-test">
          <select aria-label={t("providers.test.choose")} value={testProfile.id} onChange={(event) => setTestModelId(event.target.value)}>
            {addedProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
          <ModelConnectivityButton
            modelId={testProfile.id}
            modelName={testProfile.name}
            profileVersion={testProfile.updatedAt}
            testModel={testModel}
          />
        </span> : null}
      </div>
      {editorPanel}
      {listing?.error ? <div className="provider-discovery-error" role="alert"><strong>{t("providers.discovery.failed")}</strong><span>{listing.error}</span><small>{t("providers.discovery.fallback")}</small></div> : null}
      {listing?.list ? <small className="provider-row-source">{listing.list.source === "remote" ? t("providers.models.remote") : t("providers.models.catalog")} · {new Date(listing.list.fetchedAt).toLocaleString()}</small> : null}
      {rows.length ? <div className="provider-model-table" aria-label={t("providers.models.table", { provider: provider.name })} role="table">
        {rows.map((model) => <ProviderModelRow
          busy={busy}
          key={model.id}
          model={model}
          onAddModel={() => void onAddModel(provider.id, model.id, model, { ...EMPTY_MANUAL_MODEL })}
          onDeleteModel={(profileId) => void onDeleteModel(provider.id, model.id, profileId)}
          provider={provider}
        />)}
      </div> : listing?.list ? <p className="muted">{t("providers.models.empty")}</p> : null}
      <button aria-expanded={manualOpen} className="provider-add-model-toggle" onClick={() => setManualOpen((current) => !current)} type="button">
        {t("providers.models.add")}
      </button>
      {manualOpen ? <div className="provider-manual-form">
        <label><span>{t("providers.models.manualId")}</span><input value={manual.modelId} onChange={(event) => changeManualId(event.target.value)} placeholder={t("providers.models.manualPlaceholder")} /></label>
        <label><span>{t("providers.manual.label")}</span><input value={manual.label} onChange={(event) => setManual((current) => ({ ...current, label: event.target.value }))} placeholder={t("providers.manual.labelPlaceholder")} /></label>
        <label><span>{t("providers.manual.context")}</span><input inputMode="numeric" value={manual.contextWindow} onChange={(event) => setManual((current) => ({ ...current, contextWindow: event.target.value }))} placeholder="1000000" /></label>
        <label><span>{t("providers.manual.output")}</span><input inputMode="numeric" value={manual.maxOutputTokens} onChange={(event) => setManual((current) => ({ ...current, maxOutputTokens: event.target.value }))} placeholder="131072" /></label>
        <label><span>{t("providers.manual.efforts")}</span><input value={manual.efforts} onChange={(event) => setManual((current) => ({ ...current, efforts: event.target.value }))} placeholder={t("providers.manual.effortsPlaceholder")} /></label>
        <label className="provider-manual-vision"><input checked={manual.vision} onChange={(event) => setManual((current) => ({ ...current, vision: event.target.checked }))} type="checkbox" /><span>{t("settings.visionCapable")}</span></label>
        <div className="provider-manual-price">
          <span className="provider-manual-price-title">{t("providers.manual.price")}</span>
          <label><span>{t("providers.manual.priceCurrency")}</span><input value={manual.priceCurrency} onChange={(event) => setManual((current) => ({ ...current, priceCurrency: event.target.value }))} placeholder="USD" /></label>
          <label><span>{t("providers.manual.priceInput")}</span><input inputMode="decimal" value={manual.priceInput} onChange={(event) => setManual((current) => ({ ...current, priceInput: event.target.value }))} placeholder="1.5" /></label>
          <label><span>{t("providers.manual.priceOutput")}</span><input inputMode="decimal" value={manual.priceOutput} onChange={(event) => setManual((current) => ({ ...current, priceOutput: event.target.value }))} placeholder="3" /></label>
          <label><span>{t("providers.manual.priceCached")}</span><input inputMode="decimal" value={manual.priceCached} onChange={(event) => setManual((current) => ({ ...current, priceCached: event.target.value }))} placeholder="0.2" /></label>
        </div>
        <button className="secondary-button provider-manual-submit" disabled={busy || !manual.modelId.trim()} onClick={() => void submitManual()} type="button">{t("providers.models.add")}</button>
      </div> : null}
    </div> : null}
  </div>;
}

function ProviderEditorPanel({
  busy,
  draft,
  existing,
  onCancel,
  onChange,
  onDelete,
  onSave,
  proxySettings,
}: {
  busy: boolean;
  draft: ProviderDraft;
  existing?: ModelProvider | undefined;
  onCancel: () => void;
  onChange: (update: Partial<ProviderDraft>) => void;
  onDelete: () => void;
  onSave: () => void;
  proxySettings?: ProxySettingsDetails | undefined;
}) {
  const { t } = useLocale();
  return <section className="provider-editor" aria-label={t("providers.editor.title")}>
    <div className="provider-section-heading">
      <div><h4>{draft.providerId ? t("providers.editor.edit") : t("providers.editor.create")}</h4><p>{draft.presetId ? t("providers.editor.presetHelp") : t("providers.editor.customHelp")}</p></div>
      <div className="provider-editor-actions">
        {draft.providerId ? <button className="danger-button compact-button" disabled={busy} onClick={onDelete} type="button">{t("common.delete")}</button> : null}
        <button className="secondary-button compact-button" disabled={busy} onClick={onCancel} type="button">{t("common.cancel")}</button>
        <button className="primary-button compact-button" disabled={busy} onClick={onSave} type="button">{busy ? t("common.saving") : t("common.save")}</button>
      </div>
    </div>
    <div className="provider-editor-primary">
      <label><span>{t("providers.name")}</span><input value={draft.name} onChange={(event) => onChange({ name: event.target.value })} /></label>
      <label><span>{t("settings.apiToken")}</span><input
        autoComplete="off"
        placeholder={existing?.hasApiToken ? t("settings.apiTokenPlaceholder.saved") : draft.tokenOptional ? t("providers.token.optional") : t("settings.apiTokenPlaceholder.required")}
        type="password"
        value={draft.apiToken}
        onChange={(event) => onChange({ apiToken: event.target.value, removeToken: false })}
      /></label>
    </div>
    {existing?.hasApiToken ? <button className={draft.removeToken ? "credential-remove pending" : "credential-remove"} onClick={() => onChange({ apiToken: "", removeToken: !draft.removeToken })} type="button">
      {draft.removeToken ? t("settings.removeTokenPending") : t("settings.removeToken")}
    </button> : null}
    <details className="provider-advanced" open={!draft.presetId}>
      <summary>{t("providers.advanced")}</summary>
      <div className="provider-advanced-grid">
        <label className="provider-advanced-url"><span>{t("providers.baseUrl")}</span><input value={draft.baseUrl} onChange={(event) => onChange({ baseUrl: event.target.value })} /></label>
        <label><span>{t("settings.apiProtocol")}</span><select value={draft.apiProtocol} onChange={(event) => {
          const apiProtocol = event.target.value as ModelApiProtocol;
          onChange({ apiProtocol, apiVariant: DEFAULT_MODEL_API_VARIANT[apiProtocol], modelDiscovery: DEFAULT_MODEL_DISCOVERY[apiProtocol] });
        }}>
          <option value="openai-chat-completions">{t("settings.apiProtocol.chatCompletions")}</option>
          <option value="openai-responses">{t("settings.apiProtocol.responses")}</option>
          <option value="anthropic-messages">{t("settings.apiProtocol.anthropic")}</option>
        </select></label>
        <label><span>{t("settings.apiVariant")}</span><select value={draft.apiVariant} onChange={(event) => onChange({ apiVariant: event.target.value as ModelApiVariant })}>
          {MODEL_API_VARIANTS[draft.apiProtocol].map((variant) => <option key={variant} value={variant}>{t(`settings.apiVariant.${variant}`)}</option>)}
        </select></label>
        {proxySettings ? <ProxyPolicySelect label={t("settings.llmProxy")} onChange={(proxyPolicy) => onChange({ proxyPolicy })} settings={proxySettings} value={draft.proxyPolicy} /> : null}
      </div>
    </details>
  </section>;
}

export const ProviderModelSettings = forwardRef<ProviderModelSettingsHandle, {
  catalog?: ModelCatalogDetails;
  client: SettingsApiClient;
  models: ModelProfile[];
  onCatalogChange?: (details: ModelCatalogDetails) => void;
  onDraftStateChange?: (dirty: boolean) => void;
  onError: (message: string) => void;
  onModelsChange: (models: ModelProfile[]) => void;
  onNotice: (message: string, detail?: string) => void;
  onProvidersChange: (providers: ModelProvider[]) => void;
  presets: ModelProviderPreset[];
  providers: ModelProvider[];
  proxySettings?: ProxySettingsDetails;
}>(function ProviderModelSettings({
  catalog,
  client,
  models,
  onCatalogChange,
  onDraftStateChange,
  onError,
  onModelsChange,
  onNotice,
  onProvidersChange,
  presets,
  providers,
  proxySettings,
}, ref) {
  const { t } = useLocale();
  const [draft, setDraft] = useState<ProviderDraft>();
  const [listings, setListings] = useState<Record<string, ListingState>>({});
  const [expandedId, setExpandedId] = useState<string>();
  // The preset dropdown and custom entry stay behind one "Add provider"
  // button; with nothing configured yet it starts open as the first-run path.
  const [addOpen, setAddOpen] = useState(() => !providers.length);
  const [busy, setBusy] = useState(false);
  const baselineDraft = useRef<ProviderDraft | undefined>(undefined);
  const listingRequests = useRef(new Map<string, number>());
  const draftDirty = draftFingerprint(draft) !== draftFingerprint(baselineDraft.current);

  useEffect(() => onDraftStateChange?.(draftDirty), [draftDirty, onDraftStateChange]);
  useEffect(() => () => onDraftStateChange?.(false), [onDraftStateChange]);

  useImperativeHandle(ref, () => ({
    hasUnsavedDraft: () => draftDirty,
    saveDraft: saveProvider,
  }), [draftDirty, draft, busy, providers]);

  async function loadModels(providerId: string, refresh = false): Promise<void> {
    const sequence = (listingRequests.current.get(providerId) ?? 0) + 1;
    listingRequests.current.set(providerId, sequence);
    setListings((current) => ({ ...current, [providerId]: { ...current[providerId], error: undefined, loading: true } }));
    try {
      const list = await client.listProviderModels(providerId, refresh);
      if (listingRequests.current.get(providerId) === sequence) {
        setListings((current) => ({ ...current, [providerId]: { list, loading: false } }));
      }
    } catch (reason) {
      // Keep the last successful listing visible. Manual model entry stays
      // available so an outage is recoverable.
      const message = reason instanceof Error ? reason.message : t("providers.discovery.failed");
      if (listingRequests.current.get(providerId) === sequence) {
        setListings((current) => ({ ...current, [providerId]: { ...current[providerId], error: message, loading: false } }));
      }
    }
  }

  // Pull every configured provider's real model list so each row can show
  // added/total counts; results are cached in state and refreshed per row.
  useEffect(() => {
    for (const provider of providers) {
      if (!listings[provider.id] && !listingRequests.current.has(provider.id)) void loadModels(provider.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  function change(update: Partial<ProviderDraft>): void {
    setDraft((current) => current ? { ...current, ...update } : current);
  }

  function selectDraft(next: ProviderDraft): void {
    baselineDraft.current = next;
    setDraft(next);
    setBusy(false);
  }

  function allowDraftReplacement(): boolean {
    return !draftDirty || window.confirm(t("providers.unsaved.confirm"));
  }

  function cancelDraft(): void {
    if (!allowDraftReplacement()) return;
    baselineDraft.current = undefined;
    setDraft(undefined);
  }

  function operationError(reason: unknown, fallback: string): string {
    return providerOperationError(reason, fallback, t("providers.delete.referenced"));
  }

  function selectPreset(preset: ModelProviderPreset): void {
    if (!allowDraftReplacement()) return;
    selectDraft(presetDraft(preset));
    setAddOpen(false);
  }

  function selectCustomProvider(): void {
    if (!allowDraftReplacement()) return;
    selectDraft({ ...CUSTOM_PROVIDER });
    setAddOpen(false);
  }

  function editProvider(provider: ModelProvider): void {
    if (!allowDraftReplacement()) return;
    selectDraft(providerDraft(provider));
    setExpandedId(provider.id);
  }

  function toggleRow(providerId: string): void {
    setExpandedId((current) => current === providerId ? undefined : providerId);
  }

  async function saveProvider(): Promise<boolean> {
    if (!draft || busy) return false;
    if (!draft.name.trim() || !draft.baseUrl.trim()) {
      onError(t("providers.validation.identity"));
      return false;
    }
    const existing = draft.providerId ? providers.find((provider) => provider.id === draft.providerId) : undefined;
    setBusy(true);
    try {
      const input = {
        apiProtocol: draft.apiProtocol,
        apiVariant: draft.apiVariant,
        baseUrl: draft.baseUrl.trim(),
        modelDiscovery: draft.modelDiscovery,
        name: draft.name.trim(),
        proxyPolicy: draft.proxyPolicy,
        tokenOptional: draft.tokenOptional,
        ...(draft.apiToken.trim() ? { apiToken: draft.apiToken.trim() } : {}),
      };
      const saved = existing
        ? await client.updateProvider(existing.id, {
            ...input,
            ...(draft.removeToken ? { apiToken: null } : {}),
          })
        : await client.createProvider({ ...input, presetId: draft.presetId });
      onNotice(existing ? t("providers.notice.updated") : t("providers.notice.created"), saved.name);
      try {
        const registry = await client.listProviders();
        onProvidersChange(registry.providers);
      } catch (reason) {
        onError(operationError(reason, t("providers.load.providersFailed")));
        return false;
      }
      // Saved: back to the list, with the provider expanded and its real
      // model list refreshed.
      baselineDraft.current = undefined;
      setDraft(undefined);
      setExpandedId(saved.id);
      await loadModels(saved.id, true);
      return true;
    } catch (reason) {
      onError(operationError(reason, t("providers.validation.saveFailed")));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function deleteProvider(): Promise<void> {
    if (!draft?.providerId || busy) return;
    if (!window.confirm(t("providers.delete.confirm", { name: draft.name }))) return;
    setBusy(true);
    try {
      await client.deleteProvider(draft.providerId);
      let nextProviders = providers.filter((provider) => provider.id !== draft.providerId);
      try {
        nextProviders = (await client.listProviders()).providers;
      } catch (reason) {
        onError(operationError(reason, t("providers.load.providersFailed")));
      }
      onProvidersChange(nextProviders);
      try {
        onModelsChange(await client.listModels());
      } catch (reason) {
        onError(operationError(reason, t("providers.load.modelsFailed")));
      }
      setListings((current) => {
        const next = { ...current };
        delete next[draft.providerId!];
        return next;
      });
      baselineDraft.current = undefined;
      setDraft(undefined);
      onNotice(t("providers.notice.deleted"), draft.name);
    } catch (reason) {
      onError(operationError(reason, t("providers.delete.failed")));
    } finally {
      setBusy(false);
    }
  }

  async function addModel(
    providerId: string,
    modelId: string,
    entry: ProviderModelEntry | undefined,
    manual: ManualModelForm,
  ): Promise<boolean> {
    if (!modelId.trim() || busy) return false;
    setBusy(true);
    try {
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
      // Facts carry the user-stated effort list; without one the model simply
      // omits thinking parameters (the "model default" behaviour).
      const facts = contextWindow !== undefined || maxOutputTokens !== undefined || pricing || efforts.length
        ? {
            ...(contextWindow !== undefined ? { contextWindow } : {}),
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
            ...(pricing ? { pricing } : {}),
            ...(efforts.length ? { thinkingEfforts: efforts } : {}),
          }
        : undefined;
      const saved = await client.addProviderModel(providerId, {
        ...(label ? { label } : {}),
        model: modelId.trim(),
        ...(vision !== undefined ? { vision } : {}),
        ...(facts ? { facts } : {}),
      });
      const nextModels = [...models.filter((model) => model.id !== saved.id), saved]
        .toSorted((left, right) => left.name.localeCompare(right.name));
      onModelsChange(nextModels);
      setListings((current) => {
        const listing = current[providerId]?.list;
        if (!listing) return current;
        const known = listing.models.some((model) => model.id === modelId.trim());
        return {
          ...current,
          [providerId]: {
            ...current[providerId]!,
            list: {
              ...listing,
              models: known
                ? listing.models.map((model) => model.id === modelId.trim() ? { ...model, profileId: saved.id } : model)
                : [{ id: modelId.trim(), profileId: saved.id }, ...listing.models],
            },
            loading: false,
          },
        };
      });
      onNotice(t("providers.notice.modelAdded"), saved.name);
      return true;
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : t("providers.models.addFailed"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function deleteModel(providerId: string, modelId: string, profileId: string): Promise<boolean> {
    if (busy) return false;
    const target = models.find((model) => model.id === profileId);
    if (!window.confirm(t("providers.models.deleteConfirm", { name: target?.name ?? modelId }))) return false;
    setBusy(true);
    try {
      const deleted = target;
      await client.deleteModel(profileId);
      onModelsChange(models.filter((model) => model.id !== profileId));
      setListings((current) => {
        const listing = current[providerId]?.list;
        if (!listing) return current;
        return {
          ...current,
          [providerId]: {
            ...current[providerId]!,
            list: {
              ...listing,
              models: listing.models.map((entry) => {
                if (entry.id !== modelId || entry.profileId !== profileId) return entry;
                const { profileId: _profileId, ...unadded } = entry;
                return unadded;
              }),
            },
            loading: false,
          },
        };
      });
      onNotice(t("providers.notice.modelDeleted"), deleted?.name ?? modelId);
      return true;
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : "";
      const fallback = t("error.deleteModel");
      onError(detail ? `${fallback}: ${detail}` : fallback);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const existing = draft?.providerId ? providers.find((provider) => provider.id === draft.providerId) : undefined;
  return <div className="provider-settings">
    <ModelCatalogStatus
      {...(catalog ? { catalog } : {})}
      client={client}
      {...(onCatalogChange ? { onCatalogChange } : {})}
      onError={onError}
      onNotice={onNotice}
    />
    <section className="provider-registry" aria-label={t("providers.configured.title")}>
      <div className="provider-section-heading">
        <div><h4>{t("providers.configured.title")}</h4></div>
      </div>
      {providers.length ? <div className="provider-rows">
        {providers.map((provider) => <ProviderRow
          addedProfiles={models.filter((model) => model.providerId === provider.id)}
          busy={busy}
          {...(draft?.providerId === provider.id
            ? { editorPanel: <ProviderEditorPanel
                busy={busy}
                draft={draft}
                existing={providers.find((candidate) => candidate.id === provider.id)}
                onCancel={cancelDraft}
                onChange={change}
                onDelete={() => void deleteProvider()}
                onSave={() => void saveProvider()}
                {...(proxySettings ? { proxySettings } : {})}
              /> }
            : {})}
          expanded={expandedId === provider.id}
          key={provider.id}
          {...(listings[provider.id] ? { listing: listings[provider.id] } : {})}
          onAddModel={addModel}
          onDeleteModel={deleteModel}
          onEdit={editProvider}
          onRefresh={(providerId) => void loadModels(providerId, true)}
          onToggle={toggleRow}
          provider={provider}
          testModel={(modelId) => client.testModel(modelId)}
        />)}
      </div> : <p className="muted">{t("providers.configured.empty")}</p>}
      <div className="provider-add">
        <button aria-expanded={addOpen} className="provider-add-button" onClick={() => setAddOpen((current) => !current)} type="button">
          {t("providers.add.title")}
        </button>
        {addOpen ? <div className="provider-add-panel">
          <select
            aria-label={t("providers.add.title")}
            onChange={(event) => {
              const preset = presets.find((candidate) => candidate.id === event.target.value as ModelProviderPresetId);
              if (preset) selectPreset(preset);
            }}
            value=""
          >
            <option value="">{t("providers.add.placeholder")}</option>
            {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}{preset.tokenOptional ? ` · ${t("providers.token.optional")}` : ""}</option>)}
          </select>
          <button className="secondary-button compact-button" onClick={selectCustomProvider} type="button">{t("providers.custom.name")}</button>
        </div> : null}
      </div>
      {draft && !draft.providerId ? <ProviderEditorPanel
        busy={busy}
        draft={draft}
        onCancel={cancelDraft}
        onChange={change}
        onDelete={() => void deleteProvider()}
        onSave={() => void saveProvider()}
        {...(proxySettings ? { proxySettings } : {})}
      /> : null}
    </section>

  </div>;
});
