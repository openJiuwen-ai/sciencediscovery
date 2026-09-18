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
  ModelApiProtocol,
  ModelApiVariant,
  ModelConnectivityTestResult,
  ModelProfile,
  ModelProvider,
  ModelProviderPreset,
  ModelProviderPresetId,
  ProviderModelList,
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
  const [baseUrlOverride, setBaseUrlOverride] = useState("");
  const [presetNameOverride, setPresetNameOverride] = useState("");
  const [customProtocol, setCustomProtocol] = useState<ModelApiProtocol>("openai-chat-completions");
  const [customVariant, setCustomVariant] = useState<ModelApiVariant>("openai");
  const [advancedProxyPolicy, setAdvancedProxyPolicy] = useState<ProxyPolicy>("inherit");

  const [testing, setTesting] = useState(false);
  const [validationError, setValidationError] = useState<string>();
  const [testResult, setTestResult] = useState<ModelConnectivityTestResult>();
  const [successInfo, setSuccessInfo] = useState<{ count: number; defaultChanged: boolean; latencyMs: number; modelName: string }>();

  const selectedPreset = !isCustom ? presets.find((p) => p.id === selectedPresetId) : undefined;
  const keyUrl = selectedPreset?.keyUrl;
  const providerDisplayName = isCustom ? (customName.trim() || t("wizard.customNamePlaceholder")) : (selectedPreset?.name ?? selectedPresetId);
  // A model identifier the user typed by hand (custom provider only). When it
  // is empty the wizard enables the first entry of the provider's own model
  // listing instead of any curated recommendation.
  const explicitModelId = isCustom ? customModelId.trim() : "";
  const tokenOptional = selectedPreset?.tokenOptional === true;

  function handleProviderChange(value: string) {
    setValidationError(undefined);
    setTestResult(undefined);
    setSuccessInfo(undefined);
    setBaseUrlOverride("");
    setPresetNameOverride("");
    if (value === "custom") {
      setIsCustom(true);
    } else {
      setIsCustom(false);
      setSelectedPresetId(value);
    }
  }

  function handleCustomProtocolChange(value: string) {
    const apiProtocol = value as ModelApiProtocol;
    setCustomProtocol(apiProtocol);
    setCustomVariant(DEFAULT_MODEL_API_VARIANT[apiProtocol]);
  }

  // The models to register on this provider: the user's own identifier when
  // given, otherwise every entry of the provider's own model listing.
  // Throws a readable, already-translated error when the listing cannot
  // supply any; the caller's rollback path treats it like any other failure.
  async function resolveModelIds(providerId: string): Promise<string[]> {
    if (explicitModelId) return [explicitModelId];
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
    return ids;
  }

  async function handleTestAndEnable(): Promise<void> {
    setValidationError(undefined);
    setTestResult(undefined);
    setSuccessInfo(undefined);

    if (isCustom) {
      if (!customBaseUrl.trim()) {
        setValidationError(t("wizard.error.missingBaseUrl"));
        return;
      }
    }

    if (!apiKey.trim() && !tokenOptional) {
      setValidationError(t("wizard.error.missingKey"));
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
      const createInput = selectedPreset
        ? {
            apiProtocol: selectedPreset.apiProtocol,
            apiToken: apiKey.trim() || undefined,
            apiVariant: selectedPreset.apiVariant,
            baseUrl: baseUrlOverride.trim() || selectedPreset.baseUrl,
            modelDiscovery: selectedPreset.modelDiscovery,
            name: presetNameOverride.trim() || selectedPreset.name,
            presetId: selectedPreset.id,
            proxyPolicy: advancedProxyPolicy,
            tokenOptional: selectedPreset.tokenOptional === true,
          }
        : {
            apiProtocol: customProtocol,
            apiToken: apiKey.trim() || undefined,
            apiVariant: customVariant,
            baseUrl: customBaseUrl.trim(),
            modelDiscovery: DEFAULT_MODEL_DISCOVERY[customProtocol],
            name: customName.trim() || "Custom",
            proxyPolicy: advancedProxyPolicy,
            tokenOptional: false,
          };

      const provider = await client.createProvider(createInput);
      createdProviderId = provider.id;

      // Register the first model and prove the wire before registering more.
      const modelIds = await resolveModelIds(provider.id);
      const firstProfile = await client.addProviderModel(provider.id, {
        ...(explicitModelId ? { label: explicitModelId } : {}),
        model: modelIds[0]!,
      });
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

      // Wire proven: register the rest of the listing.
      for (const modelId of modelIds.slice(1)) {
        const profile = await client.addProviderModel(provider.id, { model: modelId });
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
              disabled={testing}
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
              disabled={testing}
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
                disabled={testing}
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
                disabled={testing}
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
                disabled={testing}
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
            <div className="wizard-advanced-grid">
              {selectedPreset ? (
                <>
                  <div className="wizard-field">
                    <label htmlFor="wizard-preset-name">{t("wizard.customNameLabel")}</label>
                    <input
                      disabled={testing}
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
                      disabled={testing}
                      id="wizard-base-url-override"
                      onChange={(e) => setBaseUrlOverride(e.target.value)}
                      placeholder={selectedPreset.baseUrl}
                      type="url"
                      value={baseUrlOverride}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="wizard-field">
                    <label htmlFor="wizard-api-protocol">{t("settings.apiProtocol")}</label>
                    <select
                      disabled={testing}
                      id="wizard-api-protocol"
                      onChange={(e) => handleCustomProtocolChange(e.target.value)}
                      value={customProtocol}
                    >
                      <option value="openai-chat-completions">{t("settings.apiProtocol.chatCompletions")}</option>
                      <option value="openai-responses">{t("settings.apiProtocol.responses")}</option>
                      <option value="anthropic-messages">{t("settings.apiProtocol.anthropic")}</option>
                    </select>
                  </div>
                  <div className="wizard-field">
                    <label htmlFor="wizard-api-variant">{t("settings.apiVariant")}</label>
                    <select
                      disabled={testing}
                      id="wizard-api-variant"
                      onChange={(e) => setCustomVariant(e.target.value as ModelApiVariant)}
                      value={customVariant}
                    >
                      {MODEL_API_VARIANTS[customProtocol].map((variant) => (
                        <option key={variant} value={variant}>{t(`settings.apiVariant.${variant}`)}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
              {proxySettings ? (
                <div className="wizard-field">
                  <label htmlFor="wizard-proxy-policy">{t("settings.llmProxy")}</label>
                  <ProxyPolicySelect
                    disabled={testing}
                    id="wizard-proxy-policy"
                    onChange={setAdvancedProxyPolicy}
                    settings={proxySettings}
                    value={advancedProxyPolicy}
                  />
                </div>
              ) : null}
            </div>
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
              disabled={testing}
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
