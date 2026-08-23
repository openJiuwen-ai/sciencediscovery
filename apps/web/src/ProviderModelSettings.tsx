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

import { useEffect, useState } from "react";

import type {
  ModelApiProtocol,
  ModelApiVariant,
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

export function PriceSummary({ model }: { model: ProviderModelEntry }) {
  const { t } = useLocale();
  const pricing = model.remote?.pricing ?? model.catalog?.pricing;
  if (!pricing) return <span>{t("providers.metadata.unknown")}</span>;
  if (pricing.periods?.length) {
    return <span className="provider-model-price-periods">
      {pricing.periods.map((period) => <span key={period.id}>
        {t(`providers.metadata.pricePeriod.${period.id}`)}: {pricing.currency} {period.input} / {period.output}
        {period.cachedInput !== undefined ? ` · ${t("providers.metadata.cachedInput")} ${period.cachedInput}` : ""}
        {` · ${t("providers.metadata.perMillion")} · ${period.schedule}`}
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
    <div><dt>{t("providers.metadata.thinking")}</dt><dd>{thinking === undefined ? unknown : thinking ? t("common.yes") : t("common.no")}{efforts?.length ? ` · ${efforts.join(" / ")}` : ""}</dd></div>
    <div className="provider-model-price"><dt>{t("providers.metadata.price")}</dt><dd><PriceSummary model={model} /></dd></div>
  </dl>;
}

function SourceLinks({ model }: { model: ProviderModelEntry }) {
  const { t } = useLocale();
  const sources = [model.remote?.pricing?.source, model.catalog?.source, model.catalog?.pricing?.source]
    .filter((source, index, all) => source && all.findIndex((candidate) => candidate?.url === source.url) === index);
  if (!sources.length) return <small>{t("providers.metadata.remoteSource")}</small>;
  return <small className="provider-model-sources">
    {sources.map((source) => source ? <a href={source.url} key={source.url} rel="noreferrer" target="_blank">
      {t("providers.metadata.officialSource")} · {source.retrievedAt}
    </a> : null)}
  </small>;
}

export function ProviderModelSettings({
  client,
  models,
  onError,
  onModelsChange,
  onNotice,
  onProvidersChange,
  presets,
  providers,
  proxySettings,
}: {
  client: SettingsApiClient;
  models: ModelProfile[];
  onError: (message: string) => void;
  onModelsChange: (models: ModelProfile[]) => void;
  onNotice: (message: string, detail?: string) => void;
  onProvidersChange: (providers: ModelProvider[]) => void;
  presets: ModelProviderPreset[];
  providers: ModelProvider[];
  proxySettings?: ProxySettingsDetails;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState<ProviderDraft>();
  const [listing, setListing] = useState<ProviderModelList>();
  const [manualModelId, setManualModelId] = useState("");
  const [discoveryError, setDiscoveryError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (draft || !providers.length) return;
    const first = providers[0]!;
    setDraft(providerDraft(first));
    void loadModels(first.id);
    // The first-provider selection is only a hydration default. User edits
    // are never reset merely because a parent list received a fresh object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.length]);

  function change(update: Partial<ProviderDraft>): void {
    setDraft((current) => current ? { ...current, ...update } : current);
  }

  async function loadModels(providerId: string, refresh = false): Promise<void> {
    setBusy(true);
    setDiscoveryError(undefined);
    try {
      setListing(await client.listProviderModels(providerId, refresh));
    } catch (reason) {
      // Keep the last successful listing visible. The manual ID path below is
      // intentionally independent of discovery so an outage is recoverable.
      const message = reason instanceof Error ? reason.message : t("providers.discovery.failed");
      setDiscoveryError(message);
    } finally {
      setBusy(false);
    }
  }

  function selectProvider(provider: ModelProvider): void {
    setDraft(providerDraft(provider));
    setListing(undefined);
    setManualModelId("");
    setDiscoveryError(undefined);
    void loadModels(provider.id);
  }

  function selectPreset(preset: ModelProviderPreset): void {
    setDraft(presetDraft(preset));
    setListing(undefined);
    setManualModelId("");
    setDiscoveryError(undefined);
  }

  async function saveProvider(): Promise<void> {
    if (!draft || busy) return;
    if (!draft.name.trim() || !draft.baseUrl.trim()) {
      onError(t("providers.validation.identity"));
      return;
    }
    const existing = draft.providerId ? providers.find((provider) => provider.id === draft.providerId) : undefined;
    if (!existing && !draft.tokenOptional && !draft.apiToken.trim()) {
      onError(t("providers.validation.token"));
      return;
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
      const registry = await client.listProviders();
      onProvidersChange(registry.providers);
      setDraft(providerDraft(saved));
      onNotice(existing ? t("providers.notice.updated") : t("providers.notice.created"), saved.name);
      await loadModels(saved.id, true);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : t("providers.validation.saveFailed"));
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
      const registry = await client.listProviders();
      const next = registry.providers[0];
      onProvidersChange(registry.providers);
      onModelsChange(await client.listModels());
      setDraft(next ? providerDraft(next) : undefined);
      setListing(undefined);
      if (next) await loadModels(next.id);
      onNotice(t("providers.notice.deleted"), draft.name);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : t("providers.delete.failed"));
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
    <section className="provider-presets" aria-label={t("providers.presets.title")}>
      <div className="provider-section-heading">
        <div><h4>{t("providers.presets.title")}</h4><p>{t("providers.presets.help")}</p></div>
        <button className="secondary-button compact-button" onClick={() => {
          setDraft({ ...CUSTOM_PROVIDER });
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
        <span className={provider.hasApiToken || provider.tokenOptional ? "model-status" : "model-status missing"} />
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
}
