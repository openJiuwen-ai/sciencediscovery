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
  existingModels: ModelProfile[];
  existingProviders: ModelProvider[];
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
  existingModels,
  existingProviders,
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
  const [customProtocol, setCustomProtocol] = useState<ModelApiProtocol>("openai-chat-completions");
  const [customVariant, setCustomVariant] = useState<ModelApiVariant>("openai");
  const [advancedProxyPolicy, setAdvancedProxyPolicy] = useState<ProxyPolicy>("inherit");

  const [testing, setTesting] = useState(false);
  const [validationError, setValidationError] = useState<string>();
  const [testResult, setTestResult] = useState<ModelConnectivityTestResult>();
  const [successInfo, setSuccessInfo] = useState<{ latencyMs: number; modelName: string }>();

  const selectedPreset = !isCustom ? presets.find((p) => p.id === selectedPresetId) : undefined;
  const keyUrl = selectedPreset?.keyUrl;
  const providerDisplayName = isCustom ? (customName.trim() || t("wizard.customNamePlaceholder")) : (selectedPreset?.name ?? selectedPresetId);
  // A model identifier the user typed by hand (custom provider only). When it
  // is empty the wizard enables the first entry of the provider's own model
  // listing instead of any curated recommendation.
  const explicitModelId = isCustom ? customModelId.trim() : "";
  const tokenOptional = selectedPreset?.tokenOptional === true;
  const matchingProvider = existingProviders.find((candidate) =>
    selectedPreset
      ? (candidate.presetId === selectedPreset.id)
      : (candidate.name === (customName.trim() || "Custom") && candidate.baseUrl === customBaseUrl.trim())
  );

  function handleProviderChange(value: string) {
    setValidationError(undefined);
    setTestResult(undefined);
    setSuccessInfo(undefined);
    setBaseUrlOverride("");
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

  // The model to register, test, and make the global default: the user's own
  // identifier when given, otherwise the first model the provider lists.
  // Throws a readable, already-translated error when the listing cannot
  // supply one; the caller's rollback path treats it like any other failure.
  async function resolveDefaultModelId(providerId: string): Promise<string> {
    if (explicitModelId) return explicitModelId;
    let listing: ProviderModelList;
    try {
      listing = await client.listProviderModels(providerId);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      throw new Error(t("wizard.error.listingFailed", { detail }));
    }
    const first = listing.models[0]?.id?.trim();
    if (!first) {
      throw new Error(t("wizard.error.noModels"));
    }
    return first;
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

    let createdTempProviderId: string | undefined;
    let createdTempModelId: string | undefined;
    let createdPermanentProviderId: string | undefined;
    let createdPermanentModelId: string | undefined;
    let initialOverrides: RuntimeSettingsOverrides = {};

    try {
      try {
        if (typeof client.getGlobalSettings === "function") {
          const currentDetails = await client.getGlobalSettings();
          initialOverrides = currentDetails.overrides ?? {};
        }
      } catch { /* ignore */ }

      if (matchingProvider) {
        // Safe testing for existing provider:
        // DO NOT overwrite matchingProvider's apiToken before testing!
        // Instead, spin up a temporary testing provider with the candidate credentials.
        // The existing provider's endpoint/protocol/proxy stay authoritative:
        // the advanced fields only apply when creating a new provider.
        const tempInput = selectedPreset
          ? {
              apiProtocol: selectedPreset.apiProtocol,
              apiToken: apiKey.trim() || undefined,
              apiVariant: selectedPreset.apiVariant,
              baseUrl: matchingProvider.baseUrl || selectedPreset.baseUrl,
              modelDiscovery: selectedPreset.modelDiscovery,
              name: `${matchingProvider.name} (temp-test)`,
              presetId: selectedPreset.id,
              proxyPolicy: matchingProvider.proxyPolicy || ("inherit" as const),
              tokenOptional: selectedPreset.tokenOptional === true,
            }
          : {
              apiProtocol: matchingProvider.apiProtocol,
              apiToken: apiKey.trim() || undefined,
              apiVariant: matchingProvider.apiVariant,
              baseUrl: matchingProvider.baseUrl,
              modelDiscovery: matchingProvider.modelDiscovery,
              name: `${matchingProvider.name} (temp-test)`,
              proxyPolicy: matchingProvider.proxyPolicy || ("inherit" as const),
              tokenOptional: matchingProvider.tokenOptional === true,
            };

        const tempProvider = await client.createProvider(tempInput);
        createdTempProviderId = tempProvider.id;

        const modelId = await resolveDefaultModelId(tempProvider.id);
        const tempProfile = await client.addProviderModel(tempProvider.id, {
          ...(explicitModelId ? { label: explicitModelId } : {}),
          model: modelId,
        });
        createdTempModelId = tempProfile.id;

        // Test connectivity on the temp model
        const testOutcome = await client.testModel(tempProfile.id);

        // Immediately clean up temporary test objects.
        // If the backend auto-defaulted the global task model to the temp model,
        // restore initialOverrides first so deleteModel is not blocked by runtime settings.
        try {
          if (typeof client.replaceGlobalSettings === "function") {
            await client.replaceGlobalSettings(initialOverrides);
          }
        } catch { /* ignore */ }
        try { await client.deleteModel(tempProfile.id); } catch { /* ignore */ }
        try { await client.deleteProvider(tempProvider.id); } catch { /* ignore */ }
        createdTempModelId = undefined;
        createdTempProviderId = undefined;

        if (!testOutcome.ok) {
          // Failure: matchingProvider was NEVER updated. Its token and models remain intact!
          setTestResult(testOutcome);
          return;
        }

        // Test succeeded! Now safe to update the existing provider's credentials
        let provider = matchingProvider;
        if (apiKey.trim()) {
          provider = await client.updateProvider(matchingProvider.id, {
            apiToken: apiKey.trim(),
          });
        }

        // Ensure model profile exists on the matching provider
        let profile = existingModels.find((m) => m.providerId === matchingProvider.id && m.model === modelId);
        if (!profile) {
          profile = await client.addProviderModel(matchingProvider.id, {
            ...(explicitModelId ? { label: explicitModelId } : {}),
            model: modelId,
          });
          createdPermanentModelId = profile.id;
        }

        // Set as global default task model
        if (onDefaultModelSet) {
          await onDefaultModelSet(profile.id);
        } else {
          await client.replaceGlobalSettings({ modelId: profile.id });
        }

        try {
          const providerList = await client.listProviders();
          onProvidersChange?.(providerList.providers);
        } catch { /* ignore */ }

        try {
          const modelList = await client.listModels();
          onModelsChange?.(modelList);
        } catch { /* ignore */ }

        setSuccessInfo({
          latencyMs: testOutcome.latencyMs,
          modelName: profile.name,
        });

        onNotice?.(t("wizard.successTitle"), t("wizard.successDesc", { model: profile.name }));
        onSuccess?.(profile, provider);
      } else {
        // No existing provider: create directly, honoring the advanced fields.
        const createInput = selectedPreset
          ? {
              apiProtocol: selectedPreset.apiProtocol,
              apiToken: apiKey.trim() || undefined,
              apiVariant: selectedPreset.apiVariant,
              baseUrl: baseUrlOverride.trim() || selectedPreset.baseUrl,
              modelDiscovery: selectedPreset.modelDiscovery,
              name: selectedPreset.name,
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
        createdPermanentProviderId = provider.id;

        const modelId = await resolveDefaultModelId(provider.id);
        const profile = await client.addProviderModel(provider.id, {
          ...(explicitModelId ? { label: explicitModelId } : {}),
          model: modelId,
        });
        createdPermanentModelId = profile.id;

        const testOutcome = await client.testModel(profile.id);

        if (!testOutcome.ok) {
          // Failed: roll back newly created model and provider.
          // Restore settings first so deleteModel is not blocked by runtime settings.
          try {
            if (typeof client.replaceGlobalSettings === "function") {
              await client.replaceGlobalSettings(initialOverrides);
            }
          } catch { /* ignore */ }
          if (createdPermanentModelId) {
            try { await client.deleteModel(createdPermanentModelId); } catch { /* ignore */ }
          }
          if (createdPermanentProviderId) {
            try { await client.deleteProvider(createdPermanentProviderId); } catch { /* ignore */ }
          }
          createdPermanentModelId = undefined;
          createdPermanentProviderId = undefined;
          setTestResult(testOutcome);
          return;
        }

        // Test succeeded!
        if (onDefaultModelSet) {
          await onDefaultModelSet(profile.id);
        } else {
          await client.replaceGlobalSettings({ modelId: profile.id });
        }

        try {
          const providerList = await client.listProviders();
          onProvidersChange?.(providerList.providers);
        } catch { /* ignore */ }

        try {
          const modelList = await client.listModels();
          onModelsChange?.(modelList);
        } catch { /* ignore */ }

        setSuccessInfo({
          latencyMs: testOutcome.latencyMs,
          modelName: profile.name,
        });

        onNotice?.(t("wizard.successTitle"), t("wizard.successDesc", { model: profile.name }));
        onSuccess?.(profile, provider);
      }
    } catch (reason) {
      try {
        if (typeof client.replaceGlobalSettings === "function") {
          await client.replaceGlobalSettings(initialOverrides);
        }
      } catch { /* ignore */ }
      if (createdTempModelId) {
        try { await client.deleteModel(createdTempModelId); } catch { /* ignore */ }
      }
      if (createdTempProviderId) {
        try { await client.deleteProvider(createdTempProviderId); } catch { /* ignore */ }
      }
      if (createdPermanentModelId) {
        try { await client.deleteModel(createdPermanentModelId); } catch { /* ignore */ }
      }
      if (createdPermanentProviderId) {
        try { await client.deleteProvider(createdPermanentProviderId); } catch { /* ignore */ }
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
            {matchingProvider ? (
              <p className="wizard-advanced-note">{t("wizard.advanced.existingNote")}</p>
            ) : (
              <div className="wizard-advanced-grid">
                {selectedPreset ? (
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
            )}
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
              <span>{t("wizard.successDesc", { model: successInfo.modelName })} ({successInfo.latencyMs} ms)</span>
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
