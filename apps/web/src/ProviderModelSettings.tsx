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

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import type {
  ModelApiProtocol,
  ModelApiVariant,
  ModelCatalogDetails,
  ModelDiscoveryStrategy,
  ModelProfile,
  ModelProvider,
  ModelProviderPreset,
  ModelProviderPresetId,
  ProviderModelEntry,
  ProviderModelList,
  ProxyPolicy,
  ProxySettingsDetails,
} from "@sciencediscovery/schema";
import {
  DEFAULT_MODEL_API_VARIANT,
  DEFAULT_MODEL_DISCOVERY,
  lookupModelCatalog,
  MODEL_API_VARIANTS,
} from "@sciencediscovery/schema";

import type { SettingsApiClient } from "./api/settings.js";
import { ModelConnectivityButton } from "./ModelConnectivityButton.js";
import { ProxyPolicySelect } from "./ProxySettingsEditor.js";
import { parseThinkingChoice, thinkingChoiceLabelKey } from "./composer/ModelPicker.js";
import { useLocale } from "./i18n/index.js";
import { modelVariantThinkingControls, thinkingChoiceOptions } from "./modelThinking.js";

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
      ...(catalog ? { catalog } : {}),
    });
  }
  for (const entry of listingModels ?? []) {
    const existing = byId.get(entry.id);
    byId.set(entry.id, existing
      ? {
          ...entry,
          catalog: entry.catalog ?? existing.catalog,
          displayName: entry.displayName ?? existing.displayName,
          profileId: entry.profileId ?? existing.profileId,
        }
      : entry);
  }
  return sortProviderModels([...byId.values()]);
}

/** One compact line of capability facts for a provider model row. */
function ModelRowFacts({ model }: { model: ProviderModelEntry }) {
  const { t } = useLocale();
  const unknown = t("providers.metadata.unknown");
  const contextWindow = mergedFact(model.remote?.contextWindow, model.catalog?.contextWindow);
  const maxOutputTokens = mergedFact(model.remote?.maxOutputTokens, model.catalog?.maxOutputTokens);
  const vision = mergedFact(model.remote?.vision, model.catalog?.vision);
  const thinking = mergedFact(model.remote?.thinkingSupported, model.catalog?.thinking?.supported);
  const efforts = model.catalog?.thinking?.efforts;
  return <span className="provider-model-row-facts">
    <span>{tokenCount(contextWindow, unknown)} {t("providers.metadata.contextShort")}</span>
    <span>{t("providers.metadata.outputShort")} {tokenCount(maxOutputTokens, unknown)}</span>
    <span>{vision === undefined ? `${t("providers.metadata.vision")} ${unknown}` : vision ? t("settings.visionCapable") : t("providers.metadata.noVision")}</span>
    <span>{thinking === undefined ? `${t("providers.metadata.thinking")} ${unknown}` : thinking
      ? (efforts?.length ? efforts.map((effort) => t(`settings.thinkingEffort.${effort}`)).join(" / ") : t("common.yes"))
      : t("common.no")}</span>
    <span className="provider-model-row-price"><PriceSummary model={model} /></span>
  </span>;
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
    <div>
      <strong>{t("providers.catalog.title")}</strong>
      <small>{t("providers.catalog.source")}</small>
      <small>{snapshot
        ? t(`providers.catalog.updated.${snapshot.origin}`, { time: new Date(snapshot.fetchedAt).toLocaleString() })
        : t("providers.catalog.missing")}</small>
    </div>
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

interface ManualModelForm {
  label: string;
  modelId: string;
  thinking: string;
  vision: boolean;
}

const EMPTY_MANUAL_MODEL: ManualModelForm = { label: "", modelId: "", thinking: "", vision: false };

export function ProviderRow({
  addedProfiles,
  busy,
  expanded,
  listing,
  onAddModel,
  onEdit,
  onRefresh,
  onToggle,
  provider,
  testModel,
}: {
  addedProfiles: ModelProfile[];
  busy: boolean;
  expanded: boolean;
  listing?: ListingState | undefined;
  onAddModel: (providerId: string, modelId: string, entry: ProviderModelEntry | undefined, manual: ManualModelForm) => Promise<boolean>;
  onEdit: (provider: ModelProvider) => void;
  onRefresh: (providerId: string) => void;
  onToggle: (providerId: string) => void;
  provider: ModelProvider;
  testModel: SettingsApiClient["testModel"];
}) {
  const { t } = useLocale();
  const [manual, setManual] = useState<ManualModelForm>({ ...EMPTY_MANUAL_MODEL });
  const [testModelId, setTestModelId] = useState("");
  const rows = mergeProviderModelRows(listing?.list?.models, addedProfiles, provider);
  // The total counts the same union the table shows, so the count, the table,
  // and the test dropdown never disagree.
  const total = listing?.list ? rows.length : undefined;
  const ready = provider.hasApiToken || provider.tokenOptional;
  const manualChoices = thinkingChoiceOptions(modelVariantThinkingControls(manual.modelId, provider.apiVariant));
  const testProfile = addedProfiles.find((profile) => profile.id === testModelId) ?? addedProfiles[0];

  async function submitManual(): Promise<void> {
    const added = await onAddModel(provider.id, manual.modelId, undefined, manual);
    if (added) setManual({ ...EMPTY_MANUAL_MODEL });
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
      {listing?.error ? <div className="provider-discovery-error" role="alert"><strong>{t("providers.discovery.failed")}</strong><span>{listing.error}</span><small>{t("providers.discovery.fallback")}</small></div> : null}
      {listing?.list ? <small className="provider-row-source">{listing.list.source === "remote" ? t("providers.models.remote") : t("providers.models.catalog")} · {new Date(listing.list.fetchedAt).toLocaleString()}</small> : null}
      {rows.length ? <div className="provider-model-table" aria-label={t("providers.models.table", { provider: provider.name })} role="table">
        {rows.map((model) => <div className="provider-model-row" key={model.id} role="row">
          <span className="provider-model-cell-name"><strong>{model.displayName ?? model.catalog?.label ?? model.id}</strong><code>{model.id}</code></span>
          <ModelRowFacts model={model} />
          <button className="secondary-button compact-button" disabled={busy || Boolean(model.profileId)} onClick={() => void onAddModel(provider.id, model.id, model, { ...EMPTY_MANUAL_MODEL })} type="button">{model.profileId ? t("providers.models.added") : t("providers.models.add")}</button>
        </div>)}
      </div> : listing?.list ? <p className="muted">{t("providers.models.empty")}</p> : null}
      <div className="provider-manual-form">
        <label><span>{t("providers.manual.label")}</span><input value={manual.label} onChange={(event) => setManual((current) => ({ ...current, label: event.target.value }))} placeholder={t("providers.manual.labelPlaceholder")} /></label>
        <label><span>{t("providers.models.manualId")}</span><input value={manual.modelId} onChange={(event) => setManual((current) => ({ ...current, modelId: event.target.value }))} placeholder={t("providers.models.manualPlaceholder")} /></label>
        <label><span>{t("providers.manual.thinking")}</span><select value={manual.thinking} onChange={(event) => setManual((current) => ({ ...current, thinking: event.target.value }))}>
          <option value="">{t("providers.manual.thinkingDefault")}</option>
          {manualChoices.map((choice) => <option key={choice.value} value={choice.value}>{t(thinkingChoiceLabelKey(choice))}</option>)}
        </select></label>
        <label className="provider-manual-vision"><input checked={manual.vision} onChange={(event) => setManual((current) => ({ ...current, vision: event.target.checked }))} type="checkbox" /><span>{t("settings.visionCapable")}</span></label>
        <button className="secondary-button" disabled={busy || !manual.modelId.trim()} onClick={() => void submitManual()} type="button">{t("providers.models.add")}</button>
      </div>
    </div> : null}
  </div>;
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

  function operationError(reason: unknown, fallback: string): string {
    return providerOperationError(reason, fallback, t("providers.delete.referenced"));
  }

  function selectPreset(preset: ModelProviderPreset): void {
    if (!allowDraftReplacement()) return;
    selectDraft(presetDraft(preset));
  }

  function selectCustomProvider(): void {
    if (!allowDraftReplacement()) return;
    selectDraft({ ...CUSTOM_PROVIDER });
  }

  function editProvider(provider: ModelProvider): void {
    if (!allowDraftReplacement()) return;
    selectDraft(providerDraft(provider));
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
    if (!existing && !draft.tokenOptional && !draft.apiToken.trim()) {
      onError(t("providers.validation.token"));
      return false;
    }
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
      const thinking = parseThinkingChoice(manual.thinking);
      const saved = await client.addProviderModel(providerId, {
        ...(label ? { label } : {}),
        model: modelId.trim(),
        ...(thinking.mode ? { thinkingMode: thinking.mode } : {}),
        ...(thinking.effort ? { thinkingEffort: thinking.effort } : {}),
        ...(vision !== undefined ? { vision } : {}),
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
        <div className="provider-add-controls">
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
        </div>
      </div>
      {providers.length ? <div className="provider-rows">
        {providers.map((provider) => <ProviderRow
          addedProfiles={models.filter((model) => model.providerId === provider.id)}
          busy={busy}
          expanded={expandedId === provider.id}
          key={provider.id}
          {...(listings[provider.id] ? { listing: listings[provider.id] } : {})}
          onAddModel={addModel}
          onEdit={editProvider}
          onRefresh={(providerId) => void loadModels(providerId, true)}
          onToggle={toggleRow}
          provider={provider}
          testModel={(modelId) => client.testModel(modelId)}
        />)}
      </div> : <p className="muted">{t("providers.configured.empty")}</p>}
    </section>

    {draft ? <section className="provider-editor" aria-label={t("providers.editor.title")}>
      <div className="provider-section-heading">
        <div><h4>{draft.providerId ? t("providers.editor.edit") : t("providers.editor.create")}</h4><p>{draft.presetId ? t("providers.editor.presetHelp") : t("providers.editor.customHelp")}</p></div>
        <div className="provider-editor-actions">
          {draft.providerId ? <button className="danger-button compact-button" disabled={busy} onClick={() => void deleteProvider()} type="button">{t("common.delete")}</button> : null}
          <button className="secondary-button compact-button" disabled={busy} onClick={() => {
            if (!allowDraftReplacement()) return;
            baselineDraft.current = undefined;
            setDraft(undefined);
          }} type="button">{t("common.cancel")}</button>
          <button className="primary-button compact-button" disabled={busy} onClick={() => void saveProvider()} type="button">{busy ? t("common.saving") : t("common.save")}</button>
        </div>
      </div>
      <div className="provider-editor-primary">
        <label><span>{t("providers.name")}</span><input value={draft.name} onChange={(event) => change({ name: event.target.value })} /></label>
        <label><span>{t("settings.apiToken")}</span><input
          autoComplete="off"
          placeholder={existing?.hasApiToken ? t("settings.apiTokenPlaceholder.saved") : draft.tokenOptional ? t("providers.token.optional") : t("settings.apiTokenPlaceholder.required")}
          type="password"
          value={draft.apiToken}
          onChange={(event) => change({ apiToken: event.target.value, removeToken: false })}
        /></label>
      </div>
      {existing?.hasApiToken ? <button className={draft.removeToken ? "credential-remove pending" : "credential-remove"} onClick={() => change({ apiToken: "", removeToken: !draft.removeToken })} type="button">
        {draft.removeToken ? t("settings.removeTokenPending") : t("settings.removeToken")}
      </button> : null}
      <details className="provider-advanced" open={!draft.presetId}>
        <summary>{t("providers.advanced")}</summary>
        <div className="provider-advanced-grid">
          <label><span>{t("providers.baseUrl")}</span><input value={draft.baseUrl} onChange={(event) => change({ baseUrl: event.target.value })} /></label>
          <label><span>{t("settings.apiProtocol")}</span><select value={draft.apiProtocol} onChange={(event) => {
            const apiProtocol = event.target.value as ModelApiProtocol;
            change({ apiProtocol, apiVariant: DEFAULT_MODEL_API_VARIANT[apiProtocol], modelDiscovery: DEFAULT_MODEL_DISCOVERY[apiProtocol] });
          }}>
            <option value="openai-chat-completions">{t("settings.apiProtocol.chatCompletions")}</option>
            <option value="openai-responses">{t("settings.apiProtocol.responses")}</option>
            <option value="anthropic-messages">{t("settings.apiProtocol.anthropic")}</option>
          </select></label>
          <label><span>{t("settings.apiVariant")}</span><select value={draft.apiVariant} onChange={(event) => change({ apiVariant: event.target.value as ModelApiVariant })}>
            {MODEL_API_VARIANTS[draft.apiProtocol].map((variant) => <option key={variant} value={variant}>{t(`settings.apiVariant.${variant}`)}</option>)}
          </select></label>
          <label><span>{t("providers.discovery.strategy")}</span><select value={draft.modelDiscovery} onChange={(event) => change({ modelDiscovery: event.target.value as ModelDiscoveryStrategy })}>
            <option value="openai-models">{t("providers.discovery.openai")}</option>
            <option value="anthropic-models">{t("providers.discovery.anthropic")}</option>
            <option value="manual">{t("providers.discovery.manual")}</option>
          </select></label>
          {proxySettings ? <ProxyPolicySelect label={t("settings.llmProxy")} onChange={(proxyPolicy) => change({ proxyPolicy })} settings={proxySettings} value={draft.proxyPolicy} /> : null}
          {!draft.presetId ? <label className="provider-token-optional"><input checked={draft.tokenOptional} onChange={(event) => change({ tokenOptional: event.target.checked })} type="checkbox" /><span>{t("providers.token.optionalToggle")}</span></label> : null}
        </div>
      </details>
    </section> : null}
  </div>;
});
