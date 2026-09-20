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

import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  CreateModelProviderRequest,
  CreateProviderModelRequest,
  ModelApiProtocol,
  ModelApiVariant,
  ModelConnectivityTestResult,
  ModelProfile,
  ModelProvider,
  ModelProviderPreset,
  ProviderModelEntry,
  ProviderModelList,
  ProviderModelPreview,
  ProxyPolicy,
  ProxySettingsDetails,
  RuntimeSettingsOverrides,
} from "@sciencediscovery/schema";
import {
  DEFAULT_MODEL_API_VARIANT,
  DEFAULT_MODEL_DISCOVERY,
  MODEL_API_VARIANTS,
} from "@sciencediscovery/schema";

import type { SettingsApiClient } from "./api/settings.js";
import { AlertCircleIcon, CheckIcon, SparkleIcon, SpinnerIcon } from "./icons.js";
import { failureCopy } from "./ModelConnectivityButton.js";
import {
  EMPTY_MANUAL_MODEL,
  ManualModelFields,
  manualModelRequest,
  ModelRowFacts,
  type ManualModelForm,
} from "./ProviderModelFields.js";
import { ProxyPolicySelect } from "./ProxySettingsEditor.js";
import { useLocale } from "./i18n/index.js";

export interface ModelConnectWizardProps {
  client: SettingsApiClient;
  onDefaultModelSet?: (modelId: string) => Promise<void>;
  onError?: (error: Error | string) => void;
  onModelsChange?: (models: ModelProfile[]) => void;
  onNotice?: (message: string, detail?: string) => void;
  onProvidersChange?: (providers: ModelProvider[]) => void;
  onSuccess?: (model: ModelProfile, provider: ModelProvider) => void;
  presets: readonly ModelProviderPreset[];
  proxySettings?: ProxySettingsDetails;
}

const CUSTOM_PROTOCOL: ModelApiProtocol = "openai-chat-completions";

/** What the row of one previewed model is called: the catalog label when the
 *  model is known, else the vendor's display name, else the bare id. */
function previewEntryName(entry: ProviderModelEntry): string {
  return entry.catalog?.label ?? entry.displayName ?? entry.id;
}

export function ModelConnectWizard({
  client,
  onDefaultModelSet,
  onError,
  onModelsChange,
  onNotice,
  onProvidersChange,
  onSuccess,
  presets,
  proxySettings,
}: ModelConnectWizardProps) {
  const { t } = useLocale();

  const [selectedPresetId, setSelectedPresetId] = useState<string>(() => presets[0]?.id ?? "deepseek");
  const [isCustom, setIsCustom] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customName, setCustomName] = useState("");
  const [customModelId, setCustomModelId] = useState("");
  // 「高级配置」在卡片内展开精细字段，永不收起向导本身。
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const footerRef = useRef<HTMLDivElement>(null);
  // Expanding grows the card; keep the expanded fields and the action row
  // inside the dialog's scroll viewport instead of letting them slip under
  // the settings footer.
  useEffect(() => {
    if (advancedOpen) footerRef.current?.scrollIntoView({ block: "nearest" });
  }, [advancedOpen]);

  // Provider-side fine tuning (advanced). Protocol and variant start from the
  // preset and stay editable, exactly like the provider editor used to allow.
  const initialPreset = presets.find((preset) => preset.id === selectedPresetId);
  const [baseUrlOverride, setBaseUrlOverride] = useState("");
  const [presetNameOverride, setPresetNameOverride] = useState("");
  const [apiProtocol, setApiProtocol] = useState<ModelApiProtocol>(initialPreset?.apiProtocol ?? CUSTOM_PROTOCOL);
  const [apiVariant, setApiVariant] = useState<ModelApiVariant>(initialPreset?.apiVariant ?? DEFAULT_MODEL_API_VARIANT[CUSTOM_PROTOCOL]);
  const [proxyPolicy, setProxyPolicy] = useState<ProxyPolicy>("inherit");

  // The model plan (advanced): a previewed listing with the rows the user
  // keeps ticked, plus models described by hand. Nothing here is written until
  // Save & connect runs; that keeps the whole card one atomic attempt.
  const [preview, setPreview] = useState<ProviderModelPreview>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [manualEntries, setManualEntries] = useState<CreateProviderModelRequest[]>([]);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualForm, setManualForm] = useState<ManualModelForm>({ ...EMPTY_MANUAL_MODEL });

  const [testing, setTesting] = useState(false);
  const [validationError, setValidationError] = useState<string>();
  const [testResult, setTestResult] = useState<ModelConnectivityTestResult>();
  const [successInfo, setSuccessInfo] = useState<{ count: number; defaultChanged: boolean; latencyMs: number; modelName: string }>();

  const selectedPreset = !isCustom ? presets.find((p) => p.id === selectedPresetId) : undefined;
  const keyUrl = selectedPreset?.keyUrl;
  const providerDisplayName = isCustom ? (customName.trim() || t("wizard.customNamePlaceholder")) : (selectedPreset?.name ?? selectedPresetId);
  // A model identifier the user typed by hand (custom provider only). It is
  // registered on its own; the listing is never consulted for it.
  const explicitModelId = isCustom ? customModelId.trim() : "";
  const tokenOptional = selectedPreset?.tokenOptional === true;
  const busy = testing || previewLoading;

  const previewSelectedCount = preview ? preview.models.filter((entry) => selectedIds.has(entry.id)).length : 0;
  // How many models Save & connect will register right now; undefined means
  // "every model the provider lists", fetched at that moment.
  const plannedCount = explicitModelId || preview || manualEntries.length
    ? new Set([
        ...(explicitModelId ? [explicitModelId] : []),
        ...(preview ? preview.models.filter((entry) => selectedIds.has(entry.id)).map((entry) => entry.id) : []),
        ...manualEntries.map((entry) => entry.model),
      ]).size
    : undefined;

  function resetPlan() {
    setPreview(undefined);
    setPreviewError(undefined);
    setSelectedIds(new Set());
    setManualEntries([]);
    setManualForm({ ...EMPTY_MANUAL_MODEL });
    setManualOpen(false);
  }

  function handleProviderChange(value: string) {
    setValidationError(undefined);
    setTestResult(undefined);
    setSuccessInfo(undefined);
    setBaseUrlOverride("");
    setPresetNameOverride("");
    resetPlan();
    if (value === "custom") {
      setIsCustom(true);
      setApiProtocol(CUSTOM_PROTOCOL);
      setApiVariant(DEFAULT_MODEL_API_VARIANT[CUSTOM_PROTOCOL]);
    } else {
      setIsCustom(false);
      setSelectedPresetId(value);
      const preset = presets.find((p) => p.id === value);
      setApiProtocol(preset?.apiProtocol ?? CUSTOM_PROTOCOL);
      setApiVariant(preset?.apiVariant ?? DEFAULT_MODEL_API_VARIANT[CUSTOM_PROTOCOL]);
    }
  }

  function handleProtocolChange(value: string) {
    const nextProtocol = value as ModelApiProtocol;
    setApiProtocol(nextProtocol);
    setApiVariant(DEFAULT_MODEL_API_VARIANT[nextProtocol]);
  }

  /** The first problem with the inputs, or undefined when a request can go. */
  function inputProblem(): string | undefined {
    if (isCustom && !customBaseUrl.trim()) return t("wizard.error.missingBaseUrl");
    if (!apiKey.trim() && !tokenOptional) return t("wizard.error.missingKey");
    return undefined;
  }

  // The provider this card would create: the preset's endpoint facts with
  // any advanced override on top, or the custom fields. Always a fresh
  // provider — the same vendor may be added several times with its own
  // name and key; existing rows are never touched.
  function providerInput(): CreateModelProviderRequest {
    const apiToken = apiKey.trim() || undefined;
    if (selectedPreset) {
      return {
        apiProtocol,
        apiToken,
        apiVariant,
        baseUrl: baseUrlOverride.trim() || selectedPreset.baseUrl,
        modelDiscovery: apiProtocol === selectedPreset.apiProtocol ? selectedPreset.modelDiscovery : DEFAULT_MODEL_DISCOVERY[apiProtocol],
        name: presetNameOverride.trim() || selectedPreset.name,
        presetId: selectedPreset.id,
        proxyPolicy,
        tokenOptional: selectedPreset.tokenOptional === true,
      };
    }
    return {
      apiProtocol,
      apiToken,
      apiVariant,
      baseUrl: customBaseUrl.trim(),
      modelDiscovery: DEFAULT_MODEL_DISCOVERY[apiProtocol],
      name: customName.trim() || "Custom",
      proxyPolicy,
      tokenOptional: false,
    };
  }

  // Fetch (or refresh) the listing of the not-yet-saved provider so the user
  // can tick models by hand. Every row starts ticked — the same "all of them"
  // the simple path registers — and a refresh keeps the user's choices for
  // ids that are still listed.
  async function fetchPreview(): Promise<void> {
    const problem = inputProblem();
    if (problem) {
      setValidationError(problem);
      return;
    }
    setValidationError(undefined);
    setPreviewError(undefined);
    setPreviewLoading(true);
    try {
      const next = await client.previewProviderModels(providerInput());
      const known = new Set(preview?.models.map((entry) => entry.id) ?? []);
      setPreview(next);
      setSelectedIds(new Set(next.models
        .map((entry) => entry.id)
        .filter((id) => !known.has(id) || selectedIds.has(id))));
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setPreviewError(t("wizard.error.listingFailed", { detail }));
    } finally {
      setPreviewLoading(false);
    }
  }

  function toggleSelected(id: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelectedIds(checked ? new Set(preview?.models.map((entry) => entry.id) ?? []) : new Set());
  }

  function addManualEntry() {
    const modelId = manualForm.modelId.trim();
    if (!modelId) return;
    const request = manualModelRequest(modelId, manualForm);
    setManualEntries((current) => [...current.filter((entry) => entry.model !== modelId), request]);
    setManualForm({ ...EMPTY_MANUAL_MODEL });
    setManualOpen(false);
  }

  function removeManualEntry(modelId: string) {
    setManualEntries((current) => current.filter((entry) => entry.model !== modelId));
  }

  // The models to register on the new provider, first one first. Anything the
  // user chose by hand — a typed identifier, ticked listing rows, manual
  // entries — is registered exactly; with no choice at all, every model the
  // provider lists is fetched now and registered. Throws a readable,
  // already-translated error when nothing can be registered; the caller's
  // rollback path treats it like any other failure.
  async function resolveModelPlan(providerId: string): Promise<CreateProviderModelRequest[]> {
    const chosen: CreateProviderModelRequest[] = [];
    const seen = new Set<string>();
    const choose = (request: CreateProviderModelRequest) => {
      if (seen.has(request.model)) return;
      seen.add(request.model);
      chosen.push(request);
    };
    if (explicitModelId) choose({ label: explicitModelId, model: explicitModelId });
    for (const entry of preview?.models ?? []) {
      if (selectedIds.has(entry.id)) choose({ model: entry.id });
    }
    for (const entry of manualEntries) choose(entry);
    if (chosen.length) return chosen;
    // A fetched list with every row unticked is an explicit "none", not a
    // request for all of them.
    if (preview) throw new Error(t("wizard.error.noSelection"));

    let listing: ProviderModelList;
    try {
      listing = await client.listProviderModels(providerId);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      throw new Error(t("wizard.error.listingFailed", { detail }));
    }
    const ids = listing.models
      .map((entry) => entry.id?.trim())
      .filter((id): id is string => Boolean(id));
    if (!ids.length) {
      throw new Error(t("wizard.error.noModels"));
    }
    return ids.map((id) => ({ model: id }));
  }

  async function handleTestAndEnable(): Promise<void> {
    setValidationError(undefined);
    setTestResult(undefined);
    setSuccessInfo(undefined);

    const problem = inputProblem();
    if (problem) {
      setValidationError(problem);
      return;
    }
    if (preview && !plannedCount) {
      setValidationError(t("wizard.error.noSelection"));
      return;
    }

    setTesting(true);

    let createdProviderId: string | undefined;
    const createdModelIds: string[] = [];
    let initialOverrides: RuntimeSettingsOverrides = {};

    try {
      try {
        if (typeof client.getGlobalSettings === "function") {
          const currentDetails = await client.getGlobalSettings();
          initialOverrides = currentDetails.overrides ?? {};
        }
      } catch { /* ignore */ }

      // Whether the system already has models BEFORE this connect decides the
      // default: only the first model ever becomes the global default. When
      // the list cannot be read, stay conservative and leave the default alone.
      let hadModels = true;
      try {
        hadModels = (await client.listModels()).length > 0;
      } catch { /* ignore */ }

      // Always create a fresh provider: the same vendor may be added several
      // times with its own name and key. Existing rows stay untouched —
      // failure rolls back only what this attempt created.
      const provider = await client.createProvider(providerInput());
      createdProviderId = provider.id;

      // Register the first model and prove the wire before registering more.
      const requests = await resolveModelPlan(provider.id);
      const firstProfile = await client.addProviderModel(provider.id, requests[0]!);
      createdModelIds.push(firstProfile.id);

      const testOutcome = await client.testModel(firstProfile.id);

      if (!testOutcome.ok) {
        // Failed: roll back everything this attempt created.
        // Restore settings first so deleteModel is not blocked by runtime settings.
        try {
          if (typeof client.replaceGlobalSettings === "function") {
            await client.replaceGlobalSettings(initialOverrides);
          }
        } catch { /* ignore */ }
        for (const id of createdModelIds) {
          try { await client.deleteModel(id); } catch { /* ignore */ }
        }
        createdModelIds.length = 0;
        if (createdProviderId) {
          try { await client.deleteProvider(createdProviderId); } catch { /* ignore */ }
        }
        createdProviderId = undefined;
        setTestResult(testOutcome);
        return;
      }

      // Wire proven: register the rest of the plan.
      for (const request of requests.slice(1)) {
        const profile = await client.addProviderModel(provider.id, request);
        createdModelIds.push(profile.id);
      }

      // Only the first model ever in the system becomes the global default.
      if (!hadModels) {
        if (onDefaultModelSet) {
          await onDefaultModelSet(firstProfile.id);
        } else {
          await client.replaceGlobalSettings({ modelId: firstProfile.id });
        }
      }

      try {
        const providerList = await client.listProviders();
        onProvidersChange?.(providerList.providers);
      } catch { /* ignore */ }

      try {
        const modelList = await client.listModels();
        onModelsChange?.(modelList);
      } catch { /* ignore */ }

      const count = createdModelIds.length;
      const defaultChanged = !hadModels;
      const successDesc = defaultChanged
        ? t("wizard.successDesc", { count, model: firstProfile.name })
        : t("wizard.successDescKeepDefault", { count });

      setSuccessInfo({
        count,
        defaultChanged,
        latencyMs: testOutcome.latencyMs,
        modelName: firstProfile.name,
      });
      // The plan belonged to the provider that now exists; the next connect
      // starts from a clean slate.
      resetPlan();

      onNotice?.(t("wizard.successTitle"), successDesc);
      onSuccess?.(firstProfile, provider);
    } catch (reason) {
      try {
        if (typeof client.replaceGlobalSettings === "function") {
          await client.replaceGlobalSettings(initialOverrides);
        }
      } catch { /* ignore */ }
      for (const id of createdModelIds) {
        try { await client.deleteModel(id); } catch { /* ignore */ }
      }
      if (createdProviderId) {
        try { await client.deleteProvider(createdProviderId); } catch { /* ignore */ }
      }
      const message = reason instanceof Error ? reason.message : String(reason);
      setValidationError(message);
      onError?.(reason instanceof Error ? reason : message);
    } finally {
      setTesting(false);
    }
  }

  let failureNode: ReactNode = null;
  if (testResult && !testResult.ok) {
    const copy = failureCopy(testResult.category, t);
    failureNode = (
      <div className="wizard-alert wizard-alert-error" role="alert">
        <AlertCircleIcon size={16} />
        <div className="wizard-alert-content">
          <strong>{copy.label}{testResult.providerStatus ? ` (${testResult.providerStatus})` : ""}: </strong>
          <span>{copy.title}</span>
          {testResult.message && testResult.message !== copy.title ? (
            <small className="wizard-alert-detail">{testResult.message}</small>
          ) : null}
        </div>
      </div>
    );
  }

  const planSummary = plannedCount === undefined
    ? t("wizard.plan.all")
    : t("wizard.plan.count", { count: plannedCount });
  const allSelected = preview !== undefined && preview.models.length > 0 && previewSelectedCount === preview.models.length;

  return (
    <section aria-label={t("wizard.title")} className="model-connect-wizard">
      <div className="wizard-header">
        <div className="wizard-header-title">
          <SparkleIcon size={18} />
          <h4>{t("wizard.title")}</h4>
        </div>
        <p className="wizard-header-desc">{t("wizard.desc")}</p>
      </div>

      <div className="wizard-body">
        <div className="wizard-inputs-row">
          <div className="wizard-field wizard-field-provider">
            <label htmlFor="wizard-provider-select">{t("wizard.providerLabel")}</label>
            <select
              disabled={busy}
              id="wizard-provider-select"
              onChange={(e) => handleProviderChange(e.target.value)}
              value={isCustom ? "custom" : selectedPresetId}
            >
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                  {preset.tokenOptional ? ` · ${t("providers.token.optional")}` : ""}
                </option>
              ))}
              <option value="custom">{t("providers.custom.name")}</option>
            </select>
          </div>

          <div className="wizard-field wizard-field-key">
            <label htmlFor="wizard-api-key">{t("wizard.apiKeyLabel")}</label>
            <input
              autoComplete="off"
              disabled={busy}
              id="wizard-api-key"
              onChange={(e) => {
                setApiKey(e.target.value);
                setValidationError(undefined);
              }}
              placeholder={tokenOptional ? t("providers.token.optional") : t("wizard.apiKeyPlaceholder")}
              type="password"
              value={apiKey}
            />
            <div className="wizard-key-guide">
              {keyUrl ? (
                <a
                  className="wizard-key-link"
                  href={keyUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {t("wizard.getKeyLink", { provider: providerDisplayName })}
                </a>
              ) : (
                <span className="wizard-key-generic">{t("wizard.getKeyGeneric")}</span>
              )}
              <span className="wizard-billing-notice">{t("wizard.billingNotice")}</span>
            </div>
          </div>
        </div>

        {isCustom ? (
          <div className="wizard-custom-grid">
            <div className="wizard-field">
              <label htmlFor="wizard-custom-name">{t("wizard.customNameLabel")}</label>
              <input
                disabled={busy}
                id="wizard-custom-name"
                onChange={(e) => setCustomName(e.target.value)}
                placeholder={t("wizard.customNamePlaceholder")}
                type="text"
                value={customName}
              />
            </div>
            <div className="wizard-field">
              <label htmlFor="wizard-custom-url">{t("wizard.customBaseUrlLabel")}</label>
              <input
                disabled={busy}
                id="wizard-custom-url"
                onChange={(e) => setCustomBaseUrl(e.target.value)}
                placeholder={t("wizard.customBaseUrlPlaceholder")}
                type="url"
                value={customBaseUrl}
              />
            </div>
            <div className="wizard-field">
              <label htmlFor="wizard-custom-model">{t("wizard.customModelLabel")}</label>
              <input
                disabled={busy}
                id="wizard-custom-model"
                onChange={(e) => setCustomModelId(e.target.value)}
                placeholder={t("wizard.customModelPlaceholder")}
                type="text"
                value={customModelId}
              />
            </div>
          </div>
        ) : null}

        {advancedOpen ? (
          <div className="wizard-advanced">
            {/* Provider side: everything the provider editor asks for when it
                creates a provider, so a gateway, a regional endpoint, or an
                unusual protocol never needs a second form. */}
            <section aria-label={t("wizard.section.provider")} className="wizard-advanced-section">
              <div className="wizard-section-heading">
                <h5 className="wizard-section-title">{t("wizard.section.provider")}</h5>
              </div>
              <div className="wizard-advanced-grid">
                {selectedPreset ? (
                  <>
                    <div className="wizard-field">
                      <label htmlFor="wizard-preset-name">{t("wizard.customNameLabel")}</label>
                      <input
                        disabled={busy}
                        id="wizard-preset-name"
                        onChange={(e) => setPresetNameOverride(e.target.value)}
                        placeholder={selectedPreset.name}
                        type="text"
                        value={presetNameOverride}
                      />
                    </div>
                    <div className="wizard-field">
                      <label htmlFor="wizard-base-url-override">{t("wizard.customBaseUrlLabel")}</label>
                      <input
                        disabled={busy}
                        id="wizard-base-url-override"
                        onChange={(e) => setBaseUrlOverride(e.target.value)}
                        placeholder={selectedPreset.baseUrl}
                        type="url"
                        value={baseUrlOverride}
                      />
                    </div>
                  </>
                ) : null}
                <div className="wizard-field">
                  <label htmlFor="wizard-api-protocol">{t("settings.apiProtocol")}</label>
                  <select
                    disabled={busy}
                    id="wizard-api-protocol"
                    onChange={(e) => handleProtocolChange(e.target.value)}
                    value={apiProtocol}
                  >
                    <option value="openai-chat-completions">{t("settings.apiProtocol.chatCompletions")}</option>
                    <option value="openai-responses">{t("settings.apiProtocol.responses")}</option>
                    <option value="anthropic-messages">{t("settings.apiProtocol.anthropic")}</option>
                  </select>
                </div>
                <div className="wizard-field">
                  <label htmlFor="wizard-api-variant">{t("settings.apiVariant")}</label>
                  <select
                    disabled={busy}
                    id="wizard-api-variant"
                    onChange={(e) => setApiVariant(e.target.value as ModelApiVariant)}
                    value={apiVariant}
                  >
                    {MODEL_API_VARIANTS[apiProtocol].map((variant) => (
                      <option key={variant} value={variant}>{t(`settings.apiVariant.${variant}`)}</option>
                    ))}
                  </select>
                </div>
                {proxySettings ? (
                  <div className="wizard-field">
                    <label htmlFor="wizard-proxy-policy">{t("settings.llmProxy")}</label>
                    <ProxyPolicySelect
                      disabled={busy}
                      id="wizard-proxy-policy"
                      onChange={setProxyPolicy}
                      settings={proxySettings}
                      value={proxyPolicy}
                    />
                  </div>
                ) : null}
              </div>
            </section>

            {/* Model side: fetch the provider's list and tick what to keep, or
                describe a model by hand. Nothing is registered until Save &
                connect proves the wire. */}
            <section aria-label={t("wizard.section.models")} className="wizard-advanced-section wizard-models">
              <div className="wizard-section-heading">
                <h5 className="wizard-section-title">{t("wizard.section.models")}</h5>
                <span className="wizard-plan-summary">{planSummary}</span>
                <button
                  className="secondary-button compact-button wizard-fetch-models"
                  disabled={busy}
                  onClick={() => void fetchPreview()}
                  type="button"
                >
                  {previewLoading ? t("wizard.models.fetching") : preview ? t("providers.models.refresh") : t("wizard.models.fetch")}
                </button>
              </div>

              {previewError ? (
                <div className="wizard-alert wizard-alert-error" role="alert">
                  <AlertCircleIcon size={16} />
                  <div className="wizard-alert-content">
                    <span>{previewError}</span>
                    <small className="wizard-alert-detail">{t("providers.discovery.fallback")}</small>
                  </div>
                </div>
              ) : null}

              {preview ? (
                preview.models.length ? (
                  <div aria-label={t("wizard.models.table")} className="wizard-model-table" role="table">
                    <label className="wizard-model-row wizard-model-row-all" role="row">
                      <input
                        aria-label={t("wizard.models.selectAll")}
                        checked={allSelected}
                        disabled={busy}
                        onChange={(e) => toggleAll(e.target.checked)}
                        type="checkbox"
                      />
                      <span>
                        <strong>{t("wizard.models.selectAll")}</strong>
                        <small>{t("wizard.models.selected", { selected: previewSelectedCount, total: preview.models.length })}</small>
                      </span>
                    </label>
                    {preview.models.map((entry) => (
                      <label className="wizard-model-row" key={entry.id} role="row">
                        <input
                          aria-label={entry.id}
                          checked={selectedIds.has(entry.id)}
                          disabled={busy}
                          onChange={(e) => toggleSelected(entry.id, e.target.checked)}
                          type="checkbox"
                        />
                        <span className="provider-model-cell-name">
                          <strong>{previewEntryName(entry)}</strong>
                          <code>{entry.id}</code>
                        </span>
                        <ModelRowFacts model={entry} />
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="muted wizard-models-empty">{t("providers.models.empty")}</p>
                )
              ) : null}

              {manualEntries.length ? (
                <ul aria-label={t("wizard.models.manualList")} className="wizard-manual-list">
                  {manualEntries.map((entry) => (
                    <li className="wizard-manual-item" key={entry.model}>
                      <span className="provider-model-cell-name">
                        <strong>{entry.label ?? entry.model}</strong>
                        <code>{entry.model}</code>
                      </span>
                      <em>{t("wizard.models.manualTag")}</em>
                      <button
                        className="danger-button compact-button wizard-manual-remove"
                        disabled={busy}
                        onClick={() => removeManualEntry(entry.model)}
                        type="button"
                      >
                        {t("wizard.models.remove")}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              <button
                aria-expanded={manualOpen}
                className="provider-add-model-toggle"
                disabled={busy}
                onClick={() => setManualOpen((open) => !open)}
                type="button"
              >
                {t("providers.models.add")}
              </button>
              {manualOpen ? (
                <ManualModelFields
                  busy={busy}
                  form={manualForm}
                  onChange={setManualForm}
                  onSubmit={addManualEntry}
                  presetId={selectedPreset?.id}
                  submitLabel={t("wizard.models.enqueue")}
                />
              ) : null}
            </section>
          </div>
        ) : null}

        {validationError ? (
          <div className="wizard-alert wizard-alert-error" role="alert">
            <AlertCircleIcon size={16} />
            <div className="wizard-alert-content">
              <span>{validationError}</span>
            </div>
          </div>
        ) : null}

        {failureNode}

        {successInfo ? (
          <div className="wizard-alert wizard-alert-success" role="status">
            <CheckIcon size={16} />
            <div className="wizard-alert-content">
              <strong>{t("wizard.successTitle")}: </strong>
              <span>
                {successInfo.defaultChanged
                  ? t("wizard.successDesc", { count: successInfo.count, model: successInfo.modelName })
                  : t("wizard.successDescKeepDefault", { count: successInfo.count })}
                {" "}({successInfo.latencyMs} ms)
              </span>
            </div>
          </div>
        ) : null}

        <div className="wizard-footer-row" ref={footerRef}>
          {/* The surrounding settings dialog closes when a press lands on its
              backdrop; a press on the wizard's own buttons must never take
              part in that gesture, even after future handler refactors. */}
          <div className="wizard-actions" onMouseDown={(event) => event.stopPropagation()}>
            <button
              aria-busy={testing}
              className="primary-button wizard-submit-button"
              disabled={busy}
              onClick={() => void handleTestAndEnable()}
              type="button"
            >
              {testing ? (
                <>
                  <SpinnerIcon className="spin" size={13} />
                  <span>{t("wizard.testingAndEnabling")}</span>
                </>
              ) : (
                <>
                  <SparkleIcon size={13} />
                  <span>{t("wizard.testAndEnable")}</span>
                </>
              )}
            </button>

            {/* Advanced configuration expands fine-tuning fields inside the
                card; it never unmounts the wizard. Showing/hiding the wizard
                belongs to the registry heading toggle. */}
            <button
              aria-expanded={advancedOpen}
              className="secondary-button compact-button"
              disabled={testing}
              onClick={() => setAdvancedOpen((open) => !open)}
              type="button"
            >
              {t("wizard.manualMode")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
