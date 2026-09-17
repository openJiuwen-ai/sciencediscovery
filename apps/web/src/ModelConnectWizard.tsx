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

import { useState, type ReactNode } from "react";

import type {
  ModelConnectivityTestResult,
  ModelProfile,
  ModelProvider,
  ModelProviderPreset,
  ModelProviderPresetId,
  ProxySettingsDetails,
} from "@sciencediscovery/schema";

import type { SettingsApiClient } from "./api/settings.js";
import { AlertCircleIcon, CheckIcon, SparkleIcon, SpinnerIcon } from "./icons.js";
import { failureCopy } from "./ModelConnectivityButton.js";
import { useLocale } from "./i18n/index.js";

export interface ModelConnectWizardProps {
  client: SettingsApiClient;
  existingModels: ModelProfile[];
  existingProviders: ModelProvider[];
  onClose?: () => void;
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
  onClose,
  onDefaultModelSet,
  onError,
  onModelsChange,
  onNotice,
  onProvidersChange,
  onSuccess,
  presets,
}: ModelConnectWizardProps) {
  const { t } = useLocale();

  const [selectedPresetId, setSelectedPresetId] = useState<string>(() => presets[0]?.id ?? "deepseek");
  const [isCustom, setIsCustom] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customName, setCustomName] = useState("");
  const [customModelId, setCustomModelId] = useState("");
  const [modelIdOverride, setModelIdOverride] = useState("");

  const [testing, setTesting] = useState(false);
  const [validationError, setValidationError] = useState<string>();
  const [testResult, setTestResult] = useState<ModelConnectivityTestResult>();
  const [successInfo, setSuccessInfo] = useState<{ latencyMs: number; modelName: string }>();

  const selectedPreset = !isCustom ? presets.find((p) => p.id === selectedPresetId) : undefined;
  const keyUrl = selectedPreset?.keyUrl;
  const providerDisplayName = isCustom ? (customName.trim() || t("wizard.customNamePlaceholder")) : (selectedPreset?.name ?? selectedPresetId);
  const effectiveModelId = isCustom
    ? customModelId.trim()
    : (modelIdOverride.trim() || selectedPreset?.recommendedModel || "gpt-4o");
  const tokenOptional = selectedPreset?.tokenOptional === true;

  function handleProviderChange(value: string) {
    setValidationError(undefined);
    setTestResult(undefined);
    setSuccessInfo(undefined);
    if (value === "custom") {
      setIsCustom(true);
    } else {
      setIsCustom(false);
      setSelectedPresetId(value);
      setModelIdOverride("");
    }
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
      if (!customModelId.trim()) {
        setValidationError(t("wizard.error.missingModel"));
        return;
      }
    }

    if (!apiKey.trim() && !tokenOptional) {
      setValidationError(t("wizard.error.missingKey"));
      return;
    }

    setTesting(true);

    let provider: ModelProvider | undefined;
    let createdProviderId: string | undefined;
    let createdModelProfileId: string | undefined;

    try {
      // 1. Resolve or create Provider
      const matchingProvider = existingProviders.find((candidate) =>
        selectedPreset
          ? (candidate.presetId === selectedPreset.id)
          : (candidate.name === (customName.trim() || "Custom") && candidate.baseUrl === customBaseUrl.trim())
      );

      if (matchingProvider) {
        provider = matchingProvider;
        if (apiKey.trim()) {
          provider = await client.updateProvider(matchingProvider.id, {
            apiToken: apiKey.trim(),
          });
        }
      } else {
        const createInput = selectedPreset
          ? {
              apiProtocol: selectedPreset.apiProtocol,
              apiToken: apiKey.trim() || undefined,
              apiVariant: selectedPreset.apiVariant,
              baseUrl: selectedPreset.baseUrl,
              modelDiscovery: selectedPreset.modelDiscovery,
              name: selectedPreset.name,
              presetId: selectedPreset.id,
              proxyPolicy: "inherit" as const,
              tokenOptional: selectedPreset.tokenOptional === true,
            }
          : {
              apiProtocol: "openai-chat-completions" as const,
              apiToken: apiKey.trim() || undefined,
              apiVariant: "openai" as const,
              baseUrl: customBaseUrl.trim(),
              modelDiscovery: "openai-models" as const,
              name: customName.trim() || "Custom",
              proxyPolicy: "inherit" as const,
              tokenOptional: false,
            };
        provider = await client.createProvider(createInput);
        createdProviderId = provider.id;
      }

      // 2. Resolve or add recommended ModelProfile
      let profile = existingModels.find((m) => m.providerId === provider!.id && m.model === effectiveModelId);
      if (!profile) {
        const label = selectedPreset?.recommendedModelLabel || effectiveModelId;
        profile = await client.addProviderModel(provider.id, {
          label,
          model: effectiveModelId,
        });
        createdModelProfileId = profile.id;
      }

      // 3. Test connectivity
      const testOutcome = await client.testModel(profile.id);

      if (!testOutcome.ok) {
        // Test failed: clean up newly created objects so no broken half-finished configuration is left
        if (createdModelProfileId) {
          try { await client.deleteModel(createdModelProfileId); } catch { /* ignore cleanup error */ }
        }
        if (createdProviderId) {
          try { await client.deleteProvider(createdProviderId); } catch { /* ignore cleanup error */ }
        }
        setTestResult(testOutcome);
        return;
      }

      // 4. Test passed: set as global default task model!
      if (onDefaultModelSet) {
        await onDefaultModelSet(profile.id);
      } else {
        await client.replaceGlobalSettings({ modelId: profile.id });
      }

      // Refresh providers and models lists
      try {
        const providerList = await client.listProviders();
        onProvidersChange?.(providerList.providers);
      } catch { /* ignore list reload error */ }

      try {
        const modelList = await client.listModels();
        onModelsChange?.(modelList);
      } catch { /* ignore list reload error */ }

      setSuccessInfo({
        latencyMs: testOutcome.latencyMs,
        modelName: profile.name,
      });

      onNotice?.(t("wizard.successTitle"), t("wizard.successDesc", { model: profile.name }));
      onSuccess?.(profile, provider);
    } catch (reason) {
      if (createdModelProfileId) {
        try { await client.deleteModel(createdModelProfileId); } catch { /* ignore */ }
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
        <div className="wizard-field">
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

        <div className="wizard-field">
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

        <div className="wizard-model-preview">
          <span className="wizard-model-badge">
            {t("wizard.recommendedModelLabel")}: <strong>{effectiveModelId}</strong>
          </span>
          <span className="wizard-model-hint">{t("wizard.recommendedModelDesc")}</span>
        </div>

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

        <div className="wizard-actions">
          <button
            aria-busy={testing}
            className="primary-button wizard-submit-button"
            disabled={testing}
            onClick={() => void handleTestAndEnable()}
            type="button"
          >
            {testing ? (
              <>
                <SpinnerIcon className="spin" size={14} />
                <span>{t("wizard.testingAndEnabling")}</span>
              </>
            ) : (
              <>
                <SparkleIcon size={14} />
                <span>{t("wizard.testAndEnable")}</span>
              </>
            )}
          </button>

          {onClose ? (
            <button
              className="secondary-button compact-button"
              disabled={testing}
              onClick={onClose}
              type="button"
            >
              {t("wizard.manualMode")}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
