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
  MODEL_API_VARIANTS,
} from "@sciencediscovery/schema";

import type { SettingsApiClient } from "./api/settings.js";
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

function ModelFacts({ model }: { model: ProviderModelEntry }) {
  const { t } = useLocale();
  const unknown = t("providers.metadata.unknown");
  const contextWindow = mergedFact(model.remote?.contextWindow, model.catalog?.contextWindow);
  const maxOutputTokens = mergedFact(model.remote?.maxOutputTokens, model.catalog?.maxOutputTokens);
  const vision = mergedFact(model.remote?.vision, model.catalog?.vision);
  const thinking = mergedFact(model.remote?.thinkingSupported, model.catalog?.thinking?.supported);
  const efforts = model.catalog?.thinking?.efforts;
  return <dl className="provider-model-facts">
    <div><dt>{t("providers.metadata.context")}</dt><dd>{tokenCount(contextWindow, unknown)}</dd></div>
    <div><dt>{t("providers.metadata.output")}</dt><dd>{tokenCount(maxOutputTokens, unknown)}</dd></div>
    <div><dt>{t("providers.metadata.vision")}</dt><dd>{vision === undefined ? unknown : vision ? t("common.yes") : t("common.no")}</dd></div>
    <div><dt>{t("providers.metadata.thinking")}</dt><dd>{thinking === undefined ? unknown : thinking ? t("common.yes") : t("common.no")}{efforts?.length ? ` · ${efforts.map((effort) => t(`settings.thinkingEffort.${effort}`)).join(" / ")}` : ""}</dd></div>
    <div className="provider-model-price"><dt>{t("providers.metadata.price")}</dt><dd><PriceSummary model={model} /></dd></div>
  </dl>;
}

function SourceLinks({ model }: { model: ProviderModelEntry }) {
  const { t } = useLocale();
  const sources = [model.remote?.pricing?.source, model.catalog?.source, model.catalog?.pricing?.source]
    .filter((source, index, all) => source && all.findIndex((candidate) =>
      candidate && canonicalSourceUrl(candidate.url) === canonicalSourceUrl(source.url)) === index);
  if (!sources.length) return <small>{t("providers.metadata.remoteSource")}</small>;
  return <small className="provider-model-sources">
    {sources.map((source) => source ? <a href={canonicalSourceUrl(source.url)} key={canonicalSourceUrl(source.url)} rel="noreferrer" target="_blank">
      {t("providers.metadata.officialSource")} · {sourceDate(source.retrievedAt)}
    </a> : null)}
  </small>;
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
  const [listing, setListing] = useState<ProviderModelList>();
  const [manualModelId, setManualModelId] = useState("");
  const [discoveryError, setDiscoveryError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const baselineDraft = useRef<ProviderDraft | undefined>(undefined);
  const listingGuard = useRef(createProviderListingRequestGuard());
  const draftDirty = draftFingerprint(draft) !== draftFingerprint(baselineDraft.current);

  useEffect(() => onDraftStateChange?.(draftDirty), [draftDirty, onDraftStateChange]);
  useEffect(() => () => onDraftStateChange?.(false), [onDraftStateChange]);

  useImperativeHandle(ref, () => ({
    hasUnsavedDraft: () => draftDirty,
    saveDraft: saveProvider,
  }), [draftDirty, draft, busy, providers]);

  useEffect(() => {
    if (draft || !providers.length) return;
    const first = providers[0]!;
    const next = providerDraft(first);
    baselineDraft.current = next;
    setDraft(next);
    void loadModels(first.id);
    // The first-provider selection is only a hydration default. User edits
    // are never reset merely because a parent list received a fresh object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.length]);

  function change(update: Partial<ProviderDraft>): void {
    setDraft((current) => current ? { ...current, ...update } : current);
  }

  function selectDraft(next: ProviderDraft): void {
    listingGuard.current.invalidate();
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

  async function loadModels(providerId: string, refresh = false): Promise<void> {
    const request = listingGuard.current.begin(providerId);
    setBusy(true);
    setDiscoveryError(undefined);
    try {
      const next = await client.listProviderModels(providerId, refresh);
      if (listingGuard.current.isCurrent(request, providerId)) setListing(next);
    } catch (reason) {
      // Keep the last successful listing visible. The manual ID path below is
      // intentionally independent of discovery so an outage is recoverable.
      const message = reason instanceof Error ? reason.message : t("providers.discovery.failed");
      if (listingGuard.current.isCurrent(request, providerId)) setDiscoveryError(message);
    } finally {
      if (listingGuard.current.isCurrent(request, providerId)) setBusy(false);
    }
  }

  function selectProvider(provider: ModelProvider): void {
    if (!allowDraftReplacement()) return;
    selectDraft(providerDraft(provider));
    setListing(undefined);
    setManualModelId("");
    setDiscoveryError(undefined);
    void loadModels(provider.id);
  }

  function selectPreset(preset: ModelProviderPreset): void {
    if (!allowDraftReplacement()) return;
    selectDraft(presetDraft(preset));
    setListing(undefined);
    setManualModelId("");
    setDiscoveryError(undefined);
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
      const savedDraft = providerDraft(saved);
      baselineDraft.current = savedDraft;
      setDraft(savedDraft);
      onNotice(existing ? t("providers.notice.updated") : t("providers.notice.created"), saved.name);
      try {
        const registry = await client.listProviders();
        onProvidersChange(registry.providers);
      } catch (reason) {
        onError(operationError(reason, t("providers.load.providersFailed")));
        return false;
      }
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
      const remaining = providers.filter((provider) => provider.id !== draft.providerId);
      let nextProviders = remaining;
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
      const next = nextProviders[0];
      if (next) selectDraft(providerDraft(next));
      else {
        listingGuard.current.invalidate();
        baselineDraft.current = undefined;
        setDraft(undefined);
      }
      setListing(undefined);
      if (next) await loadModels(next.id);
      onNotice(t("providers.notice.deleted"), draft.name);
    } catch (reason) {
      onError(operationError(reason, t("providers.delete.failed")));
    } finally {
      setBusy(false);
    }
  }

  async function addModel(modelId: string, entry?: ProviderModelEntry): Promise<void> {
    if (!draft?.providerId || !modelId.trim() || busy) return;
    setBusy(true);
    try {
      const saved = await client.addProviderModel(draft.providerId, {
        label: entry?.displayName ?? entry?.catalog?.label,
        model: modelId.trim(),
        vision: mergedFact(entry?.remote?.vision, entry?.catalog?.vision),
      });
      const nextModels = [...models.filter((model) => model.id !== saved.id), saved]
        .toSorted((left, right) => left.name.localeCompare(right.name));
      onModelsChange(nextModels);
      setManualModelId("");
      setListing((current) => current ? {
        ...current,
        models: current.models.map((model) => model.id === modelId ? { ...model, profileId: saved.id } : model),
      } : current);
      onNotice(t("providers.notice.modelAdded"), saved.name);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : t("providers.models.addFailed"));
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
    <section className="provider-presets" aria-label={t("providers.presets.title")}>
      <div className="provider-section-heading">
        <div><h4>{t("providers.presets.title")}</h4><p>{t("providers.presets.help")}</p></div>
        <button className="secondary-button compact-button" onClick={() => {
          if (!allowDraftReplacement()) return;
          selectDraft({ ...CUSTOM_PROVIDER });
          setListing(undefined);
          setDiscoveryError(undefined);
        }} type="button">{t("providers.custom.new")}</button>
      </div>
      <div className="provider-preset-grid">
        {presets.map((preset) => <button
          className={draft?.presetId === preset.id && !draft.providerId ? "provider-preset-card active" : "provider-preset-card"}
          key={preset.id}
          onClick={() => selectPreset(preset)}
          type="button"
        ><strong>{preset.name}</strong><small>{preset.tokenOptional ? t("providers.token.optional") : t("providers.token.only")}</small></button>)}
      </div>
    </section>

    {providers.length ? <section className="provider-registry" aria-label={t("providers.configured.title")}>
      <h4>{t("providers.configured.title")}</h4>
      <div className="provider-registry-list">{providers.map((provider) => <button
        className={provider.id === draft?.providerId ? "provider-registry-card active" : "provider-registry-card"}
        key={provider.id}
        onClick={() => selectProvider(provider)}
        type="button"
      >
        <span
          aria-label={provider.hasApiToken || provider.tokenOptional ? t("providers.status.ready") : t("providers.status.missingToken")}
          className={provider.hasApiToken || provider.tokenOptional ? "model-status" : "model-status missing"}
          role="img"
          title={provider.hasApiToken || provider.tokenOptional ? t("providers.status.ready") : t("providers.status.missingToken")}
        />
        <span><strong>{provider.name}</strong><small>{provider.baseUrl}</small></span>
        <em>{provider.presetId ? t("providers.kind.builtIn") : t("providers.kind.custom")}</em>
      </button>)}</div>
    </section> : null}

    {draft ? <section className="provider-editor" aria-label={t("providers.editor.title")}>
      <div className="provider-section-heading">
        <div><h4>{draft.providerId ? t("providers.editor.edit") : t("providers.editor.create")}</h4><p>{draft.presetId ? t("providers.editor.presetHelp") : t("providers.editor.customHelp")}</p></div>
        <div className="provider-editor-actions">
          {draft.providerId ? <button className="danger-button compact-button" disabled={busy} onClick={() => void deleteProvider()} type="button">{t("common.delete")}</button> : null}
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

    {draft?.providerId ? <section className="provider-model-catalog" aria-label={t("providers.models.title")}>
      <div className="provider-section-heading">
        <div><h4>{t("providers.models.title")}</h4><p>{t("providers.models.help")}</p></div>
        <button className="secondary-button compact-button" disabled={busy} onClick={() => void loadModels(draft.providerId!, true)} type="button">{busy ? t("common.loading") : t("providers.models.refresh")}</button>
      </div>
      {listing ? <p className="provider-list-source">{listing.source === "remote" ? t("providers.models.remote") : t("providers.models.catalog")} · {new Date(listing.fetchedAt).toLocaleString()}</p> : null}
      {discoveryError ? <div className="provider-discovery-error" role="alert"><strong>{t("providers.discovery.failed")}</strong><span>{discoveryError}</span><small>{t("providers.discovery.fallback")}</small></div> : null}
      <div className="provider-manual-model">
        <label><span>{t("providers.models.manualId")}</span><input value={manualModelId} onChange={(event) => setManualModelId(event.target.value)} placeholder={t("providers.models.manualPlaceholder")} /></label>
        <button className="secondary-button" disabled={busy || !manualModelId.trim()} onClick={() => void addModel(manualModelId)} type="button">{t("providers.models.add")}</button>
      </div>
      <div className="provider-model-list">
        {listing?.models.map((model) => <article className="provider-model-card" key={model.id}>
          <header><div><strong>{model.displayName ?? model.catalog?.label ?? model.id}</strong><code>{model.id}</code></div><button className="secondary-button compact-button" disabled={busy || Boolean(model.profileId)} onClick={() => void addModel(model.id, model)} type="button">{model.profileId ? t("providers.models.added") : t("providers.models.add")}</button></header>
          <ModelFacts model={model} />
          {model.catalog?.pricing?.notes ? <small className="provider-price-note">{model.catalog.pricing.notes}</small> : null}
          <SourceLinks model={model} />
        </article>)}
        {listing && !listing.models.length ? <p className="muted">{t("providers.models.empty")}</p> : null}
      </div>
    </section> : null}
  </div>;
});
