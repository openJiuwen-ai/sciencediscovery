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
  ProviderModelPreview,
  ProxyPolicy,
  ProxySettingsDetails,
} from "@sciencediscovery/schema";
import {
  DEFAULT_MODEL_API_VARIANT,
  DEFAULT_MODEL_DISCOVERY,
  MODEL_API_VARIANTS,
} from "@sciencediscovery/schema";

import type { SettingsApiClient } from "./api/settings.js";
import { replaceDefaultModelOverride } from "./default-model-override.js";
import { AlertCircleIcon, CheckIcon, SparkleIcon, SpinnerIcon } from "./icons.js";
import { failureCopy } from "./ModelConnectivityButton.js";
import { isPlaintextModelUrl, normalizedModelBaseUrl } from "./model-url.js";
import { ModelRowFacts } from "./ProviderModelFields.js";
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
  providers?: readonly ModelProvider[];
  proxySettings?: ProxySettingsDetails;
  /** Inline configuration binds a Session without changing the global default. */
  setFirstModelAsGlobalDefault?: boolean;
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
  providers = [],
  proxySettings,
  setFirstModelAsGlobalDefault = true,
}: ModelConnectWizardProps) {
  const { t } = useLocale();

  const [selectedPresetId, setSelectedPresetId] = useState<string>(() => presets[0]?.id ?? "deepseek");
  const [isCustom, setIsCustom] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customName, setCustomName] = useState("");
  const [customModelId, setCustomModelId] = useState("");
  const autoCustomRef = useRef(false);
  // Automatic custom mode may yield to a preset only until the user edits a
  // configuration field. Whether those fields are currently empty is the wrong
  // signal: clearing one to retype it, or filling only the API key, is an edit.
  const userConfiguredRef = useRef(false);
  function noteUserConfigured() {
    userConfiguredRef.current = true;
  }
  // 「高级配置」在卡片内展开精细字段，永不收起向导本身。
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const footerRef = useRef<HTMLDivElement>(null);

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
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  // A typed identifier is the listing's explicit fallback: it registers
  // exactly that model whether or not discovery returned anything.
  const [manualModelId, setManualModelId] = useState("");
  const previewSequence = useRef(0);

  // Expanding grows the card; keep the expanded fields and the action row
  // inside the dialog's scroll viewport instead of letting them slip under
  // the settings footer. A fetched listing grows it the same way.
  useEffect(() => {
    if (advancedOpen || preview) footerRef.current?.scrollIntoView({ block: "nearest" });
  }, [advancedOpen, preview]);

  const [testing, setTesting] = useState(false);
  const [probeConsent, setProbeConsent] = useState(false);
  useEffect(() => setProbeConsent(false), [apiKey, customBaseUrl, customModelId, apiProtocol, apiVariant, proxyPolicy, baseUrlOverride, selectedPresetId, isCustom]);
  const [validationError, setValidationError] = useState<string>();
  const [testResult, setTestResult] = useState<ModelConnectivityTestResult>();
  const [successInfo, setSuccessInfo] = useState<{ count: number; defaultChanged: boolean; latencyMs: number; modelName: string }>();
  const successInfoRef = useRef(successInfo);
  successInfoRef.current = successInfo;

  const selectedPreset = !isCustom ? presets.find((p) => p.id === selectedPresetId) : undefined;
  const keyUrl = selectedPreset?.keyUrl;
  const providerDisplayName = isCustom ? (customName.trim() || t("wizard.customNamePlaceholder")) : (selectedPreset?.name ?? selectedPresetId);
  // A model identifier the user typed by hand (custom provider only). It is
  // registered on its own; the listing is never consulted for it.
  const explicitModelId = isCustom ? customModelId.trim() : "";
  const tokenOptional = selectedPreset?.tokenOptional === true;
  // Editing the provider/key must stay possible while the debounced listing
  // fetch is pending. Only actions that would race that fetch are gated.
  const busy = testing;
  const interactionBusy = testing || previewLoading || previewPending;
  const endpoint = providerInput();
  const hasHttpDestination = isPlaintextModelUrl(endpoint.baseUrl);

  const previewSelectedCount = preview ? preview.models.filter((entry) => selectedIds.has(entry.id)).length : 0;
  const typedModelIds = [explicitModelId, manualModelId.trim()].filter(Boolean);
  // How many models Add provider will register right now. Zero is an explicit
  // choice too: the submit path then asks for a tick or a typed ID instead of
  // silently registering the whole listing.
  const plannedCount = new Set([
    ...typedModelIds,
    ...(preview ? preview.models.filter((entry) => selectedIds.has(entry.id)).map((entry) => entry.id) : []),
  ]).size;
  // A complete typed plan does not depend on the listing, so it may submit
  // while the automatic preview is still pending or hanging.
  const submitBlockedByPreview = interactionBusy && typedModelIds.length === 0;
  const endpointIdentity = JSON.stringify({
    apiProtocol,
    apiVariant,
    baseUrlOverride,
    customBaseUrl,
    isCustom,
    proxyPolicy,
    selectedPresetId,
  });
  const endpointIdentityRef = useRef(endpointIdentity);

  // A listing belongs to one endpoint. When the endpoint changes, old ticks
  // must not remain submitable while the new preview is in flight or failed.
  // The display name and API key are deliberately excluded: neither changes
  // the endpoint, so editing them keeps the listing and only refreshes it.
  useEffect(() => {
    if (endpointIdentityRef.current === endpointIdentity) return;
    endpointIdentityRef.current = endpointIdentity;
    previewSequence.current += 1;
    setPreview(undefined);
    setPreviewError(undefined);
    setSelectedIds(new Set());
    setPreviewPending(false);
    setPreviewLoading(false);
  }, [endpointIdentity]);

  function resetPlan() {
    previewSequence.current += 1;
    setPreviewPending(false);
    setPreviewLoading(false);
    setPreview(undefined);
    setPreviewError(undefined);
    setSelectedIds(new Set());
    setManualModelId("");
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

  // A preset that is no longer offered (the list arrived late, changed, or is
  // empty) would leave the select showing one option while the card acts on
  // another, and re-picking the shown option fires no change event. Custom
  // mode entered only for lack of presets yields to the first preset once
  // one arrives, unless the user has edited a configuration field.
  useEffect(() => {
    if (isCustom) {
      if (autoCustomRef.current && presets[0] && !userConfiguredRef.current) {
        autoCustomRef.current = false;
        handleProviderChange(presets[0].id);
      }
      return;
    }
    if (presets.some((preset) => preset.id === selectedPresetId)) return;
    autoCustomRef.current = !presets[0];
    handleProviderChange(presets[0]?.id ?? "custom");
  }, [isCustom, presets, selectedPresetId]);

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
  function providerInput(): CreateModelProviderRequest & { baseUrl: string } {
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

  // Fetch (or refresh) the listing of the not-yet-saved provider. The list is
  // visible before the user commits anything; a refresh keeps the ticks for
  // ids that are still listed. Nothing is ticked automatically.
  async function fetchPreview(): Promise<void> {
    const problem = inputProblem();
    if (problem) {
      setValidationError(problem);
      return;
    }
    const sequence = previewSequence.current + 1;
    previewSequence.current = sequence;
    setValidationError(undefined);
    setPreviewError(undefined);
    setPreviewPending(false);
    setPreviewLoading(true);
    try {
      const next = await client.previewProviderModels(providerInput());
      if (previewSequence.current !== sequence) return;
      setPreview(next);
      setSelectedIds((current) => new Set(next.models
        .map((entry) => entry.id)
        .filter((id) => current.has(id))));
    } catch (reason) {
      if (previewSequence.current !== sequence) return;
      const detail = reason instanceof Error ? reason.message : String(reason);
      setPreviewError(t("wizard.error.listingFailed", { detail }));
    } finally {
      if (previewSequence.current === sequence) {
        setPreviewLoading(false);
        setPreviewPending(false);
      }
    }
  }

  // The listing is the default view, not a hidden second step: fetch it as
  // soon as the provider inputs can make a request, debounced while typing.
  useEffect(() => {
    // Invalidate any in-flight response as soon as newer inputs are scheduled;
    // otherwise an older listing could land during the debounce and clear the
    // pending gate before the request for these inputs has even started.
    previewSequence.current += 1;
    if (successInfo || inputProblem()) {
      setPreviewPending(false);
      setPreviewLoading(false);
      return;
    }
    setPreviewPending(true);
    const timer = setTimeout(() => {
      // A submit may have finished while this timer was queued; never start a
      // listing fetch behind the Done state.
      if (successInfoRef.current) return;
      void fetchPreview();
    }, 450);
    return () => clearTimeout(timer);
    // The provider inputs are the trigger; fetchPreview reads the values of
    // this render when the debounce fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCustom, selectedPresetId, apiKey, customBaseUrl, apiProtocol, apiVariant, proxyPolicy, baseUrlOverride]);

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

  // The models to register on the new provider, first one first. A typed ID
  // and ticked listing rows are the complete plan; there is no "register
  // everything" fallback. Reads only what the user chose and never touches
  // the saved provider's listing.
  function resolveModelPlan(): CreateProviderModelRequest[] {
    const chosen: CreateProviderModelRequest[] = [];
    const seen = new Set<string>();
    const choose = (request: CreateProviderModelRequest) => {
      if (seen.has(request.model)) return;
      seen.add(request.model);
      chosen.push(request);
    };
    if (explicitModelId) choose({ label: explicitModelId, model: explicitModelId });
    if (manualModelId.trim()) choose({ model: manualModelId.trim() });
    for (const entry of preview?.models ?? []) {
      if (selectedIds.has(entry.id)) choose({ model: entry.id });
    }
    if (chosen.length) return chosen;
    if (preview && preview.models.length === 0) throw new Error(t("wizard.error.noModels"));
    throw new Error(t("wizard.error.noSelection"));
  }

  async function handleTestAndEnable(): Promise<void> {
    if (!probeConsent || testing || submitBlockedByPreview) return;
    setValidationError(undefined);
    setTestResult(undefined);
    setSuccessInfo(undefined);

    const problem = inputProblem();
    if (problem) {
      setValidationError(problem);
      return;
    }
    if (!plannedCount) {
      const emptyListing = preview !== undefined && preview.models.length === 0;
      const noSelection = emptyListing ? t("wizard.error.noModels") : t("wizard.error.noSelection");
      setValidationError(previewError ?? noSelection);
      return;
    }
    // A typed plan may be complete while a preview is still in flight. Claim
    // the current sequence so a late listing cannot land after this submit.
    previewSequence.current += 1;
    setPreviewPending(false);
    setPreviewLoading(false);
    const input = providerInput();
    const inputName = input.name ?? providerDisplayName;
    if (providers.some((provider) => provider.name === inputName)
      && !window.confirm(t("wizard.error.duplicateProvider", { name: inputName }))) {
      return;
    }

    setTesting(true);

    let createdProviderId: string | undefined;
    const createdModelIds: string[] = [];
    const clearAttemptDefault = async (): Promise<void> => {
      for (const id of createdModelIds) {
        try { await client.clearGlobalModelIfCurrent(id); } catch { /* ignore */ }
      }
    };

    try {
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
      const provider = await client.createProvider(input);
      createdProviderId = provider.id;

      // Register the first model and prove the wire before registering more.
      const requests = resolveModelPlan();
      const firstProfile = await client.addProviderModel(provider.id, {
        ...requests[0]!,
        ...(setFirstModelAsGlobalDefault ? {} : { setGlobalDefault: false }),
      });
      createdModelIds.push(firstProfile.id);

      // The saved profile must match the endpoint entered in this form.
      if (hasHttpDestination && (normalizedModelBaseUrl(firstProfile.baseUrl) !== normalizedModelBaseUrl(endpoint.baseUrl)
        || firstProfile.apiProtocol !== apiProtocol || firstProfile.apiVariant !== apiVariant)) {
        throw new Error(t("settings.modelTest.httpChanged"));
      }
      const testOutcome = await client.testModel(firstProfile.id, false, hasHttpDestination
        ? { baseUrl: endpoint.baseUrl, profileUpdatedAt: firstProfile.updatedAt } : undefined);

      if (!testOutcome.ok) {
        // Failed: roll back everything this attempt created.
        // Remove only this attempt's auto-default; unrelated concurrent
        // settings edits and newer default selections must remain intact.
        await clearAttemptDefault();
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
        const profile = await client.addProviderModel(provider.id, {
          ...request,
          ...(setFirstModelAsGlobalDefault ? {} : { setGlobalDefault: false }),
        });
        createdModelIds.push(profile.id);
      }

      // Only the first model ever in the system becomes the global default.
      if (!hadModels && setFirstModelAsGlobalDefault) {
        if (onDefaultModelSet) {
          await onDefaultModelSet(firstProfile.id);
        } else {
          await replaceDefaultModelOverride(client, firstProfile.id);
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
      const defaultChanged = !hadModels && setFirstModelAsGlobalDefault;
      // The probe that gate-kept this save is the basic one: a minimal
      // request the provider answered. The success copy says so instead of
      // claiming the model can run tasks (issue #824).
      const successDesc = defaultChanged
        ? t("wizard.successDesc", { count, model: firstProfile.name })
        : t(setFirstModelAsGlobalDefault ? "wizard.successDescKeepDefault" : "wizard.successDescSession", { count });

      setSuccessInfo({
        count,
        defaultChanged,
        latencyMs: testOutcome.latencyMs,
        modelName: firstProfile.name,
      });
      // The flow is over: nothing from the completed attempt stays in the
      // form, so a second press cannot create a duplicate provider.
      resetPlan();
      setApiKey("");
      setCustomName("");
      setCustomBaseUrl("");
      setCustomModelId("");
      setPresetNameOverride("");
      setBaseUrlOverride("");

      onNotice?.(t("wizard.successTitle"), successDesc);
      onSuccess?.(firstProfile, provider);
    } catch (reason) {
      await clearAttemptDefault();
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

  const planSummary = plannedCount
    ? t("wizard.plan.count", { count: plannedCount })
    : t("wizard.plan.none");
  const allSelected = preview !== undefined && preview.models.length > 0 && previewSelectedCount === preview.models.length;
  const doneNode = successInfo ? <div className="wizard-alert wizard-alert-success wizard-done" role="status">
    <CheckIcon size={16} />
    <div className="wizard-alert-content">
      <strong>{t("wizard.doneTitle")}</strong>
      <span>{t("wizard.doneDesc")}</span>
      <span>
        {successInfo.defaultChanged
          ? t("wizard.successDesc", { count: successInfo.count, model: successInfo.modelName })
          : t("wizard.successDescKeepDefault", { count: successInfo.count })}
        {" "}({successInfo.latencyMs} ms)
      </span>
      <button className="secondary-button compact-button" onClick={() => { setSuccessInfo(undefined); setValidationError(undefined); }} type="button">
        {t("wizard.doneAgain")}
      </button>
    </div>
  </div> : null;

  return (
    <section aria-label={t("wizard.title")} className="model-connect-wizard">
      <div className="wizard-header">
        <div className="wizard-header-title">
          <SparkleIcon size={18} />
          <h4>{t("wizard.title")}</h4>
        </div>
        <p className="wizard-header-desc">{t(setFirstModelAsGlobalDefault ? "wizard.desc" : "wizard.descSession")}</p>
      </div>

      {successInfo ? doneNode : <div className="wizard-body">
        <div className="wizard-inputs-row">
          <div className="wizard-field wizard-field-provider">
            <label htmlFor="wizard-provider-select">{t("wizard.providerLabel")}</label>
            <select
              disabled={busy}
              id="wizard-provider-select"
              onChange={(e) => {
                autoCustomRef.current = false;
                handleProviderChange(e.target.value);
              }}
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
                noteUserConfigured();
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
                onChange={(e) => {
                  noteUserConfigured();
                  setCustomName(e.target.value);
                }}
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
                onChange={(e) => {
                  noteUserConfigured();
                  setCustomBaseUrl(e.target.value);
                }}
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
                onChange={(e) => {
                  noteUserConfigured();
                  setCustomModelId(e.target.value);
                }}
                placeholder={t("wizard.customModelPlaceholder")}
                type="text"
                value={customModelId}
              />
            </div>
          </div>
        ) : null}

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

        {!isCustom && (preview || previewError || !inputProblem()) ? <div className="wizard-field wizard-manual-model">
          <label htmlFor="wizard-manual-model">{t("wizard.manualModelLabel")}</label>
          <input
            disabled={busy}
            id="wizard-manual-model"
            onChange={(event) => {
              noteUserConfigured();
              setManualModelId(event.target.value);
              setValidationError(undefined);
            }}
            placeholder={t("wizard.manualModelPlaceholder")}
            type="text"
            value={manualModelId}
          />
        </div> : null}

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
                        onChange={(e) => {
                          noteUserConfigured();
                          setPresetNameOverride(e.target.value);
                        }}
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
                        onChange={(e) => {
                          noteUserConfigured();
                          setBaseUrlOverride(e.target.value);
                        }}
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
                    onChange={(e) => {
                      noteUserConfigured();
                      handleProtocolChange(e.target.value);
                    }}
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
                    onChange={(e) => {
                      noteUserConfigured();
                      setApiVariant(e.target.value as ModelApiVariant);
                    }}
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
                      onChange={(policy) => {
                        noteUserConfigured();
                        setProxyPolicy(policy);
                      }}
                      settings={proxySettings}
                      value={proxyPolicy}
                    />
                  </div>
                ) : null}
              </div>
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

        <div className="wizard-footer-row" ref={footerRef}>
          {/* The listing and its explicit ticks sit above; fetching lives next
              to the submit so the plan is visible before anything is written. */}
          <div className="wizard-fetch-side">
            <button
              className="secondary-button compact-button wizard-fetch-models"
              disabled={interactionBusy}
              onClick={() => void fetchPreview()}
              type="button"
            >
              {previewLoading || previewPending ? t("wizard.models.fetching") : preview ? t("providers.models.refresh") : t("wizard.models.fetch")}
            </button>
            <div className="wizard-fetch-copy">
              <span className="wizard-plan-summary">{planSummary}</span>
              <label className="wizard-probe-consent"><input type="checkbox" checked={probeConsent} onChange={e => setProbeConsent(e.target.checked)} disabled={busy} />{t("settings.modelTest.basicConsent")}</label>
            </div>
          </div>
          {/* The surrounding settings dialog closes when a press lands on its
              backdrop; a press on the wizard's own buttons must never take
              part in that gesture, even after future handler refactors. */}
          <div className="wizard-actions" onMouseDown={(event) => event.stopPropagation()}>
            <button
              aria-busy={testing}
              className="primary-button wizard-submit-button"
              disabled={testing || submitBlockedByPreview || !probeConsent}
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
      </div>}
    </section>
  );
}
