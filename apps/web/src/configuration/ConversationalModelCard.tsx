// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0

import { useState } from "react";
import type { ModelProfile, ModelProvider, ModelProviderPreset, ProxySettingsDetails } from "@sciencediscovery/schema";
import type { SettingsApiClient } from "../api/settings.js";
import { ModelConnectWizard } from "../ModelConnectWizard.js";
import { useLocale } from "../i18n/index.js";

export interface ConversationalModelCardProps {
  client: SettingsApiClient;
  models: ModelProfile[];
  onApply: (model: ModelProfile, firstModelSetup: boolean) => Promise<void>;
  onDismiss: () => void;
  onModelsChange: (models: ModelProfile[]) => void;
  onProvidersChange: (providers: ModelProvider[]) => void;
  pendingTask: boolean;
  presets: readonly ModelProviderPreset[];
  providers: ModelProvider[];
  proxySettings?: ProxySettingsDetails;
}

/** A real configuration entry in the conversation. The provider wizard uses
 * the existing backend validation and encrypted credential store; this card
 * never sends a key as a chat message or stores it in browser storage. */
export function ConversationalModelCard({
  client, models, onApply, onDismiss, onModelsChange, onProvidersChange,
  pendingTask, presets, providers, proxySettings,
}: ConversationalModelCardProps) {
  const { t } = useLocale();
  const [selectedId, setSelectedId] = useState("");
  const [showConnectWizard, setShowConnectWizard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [connectedModel, setConnectedModel] = useState<ModelProfile>();
  // Keep the approved scope stable while the wizard registers the first model.
  // Its model-list callback can update `models` before the session binding ends.
  const [firstModelSetup] = useState(() => models.length === 0);
  const selected = models.find((model) => model.id === selectedId) ?? models[0];

  async function apply(model: ModelProfile): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onApply(model, firstModelSetup);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return <section aria-label={t(firstModelSetup ? "configuration.card.firstTitle" : "configuration.card.title")} className="conversation-configuration-card" id="conversation-configuration-card">
    <div className="conversation-configuration-heading">
      <div>
        <span className="eyebrow">{t("configuration.card.eyebrow")}</span>
        <h3>{t(firstModelSetup ? "configuration.card.firstTitle" : "configuration.card.title")}</h3>
      </div>
      <span className="conversation-configuration-status">{t("configuration.card.awaiting")}</span>
    </div>
    <p>{t(firstModelSetup ? "configuration.card.firstReason" : "configuration.card.reason")}</p>
    <div className="conversation-configuration-impact">
      <span>{t("configuration.card.saveLocation")}</span>
      <strong>{models.length && !showConnectWizard ? t("configuration.card.existingResource") : t("configuration.card.deploymentResource")}</strong>
      <span>{t("configuration.card.useScope")}</span>
      <strong>{t(firstModelSetup ? "configuration.card.firstScope" : "configuration.card.sessionScope")}</strong>
      <span>{t("configuration.card.continuation")}</span>
      <strong>{pendingTask ? t("configuration.card.continueTask") : t("configuration.card.waitTask")}</strong>
    </div>
    {models.length ? <div className="conversation-configuration-selection">
      <label htmlFor="conversation-configuration-model">{t("configuration.card.selectModel")}</label>
      <select id="conversation-configuration-model" value={selected?.id ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
        {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select>
      <div className="conversation-configuration-actions">
        <button className="primary-button" disabled={!selected || busy} onClick={() => selected && void apply(selected)} type="button">
          {busy ? t("configuration.card.applying") : pendingTask ? t("configuration.card.applyContinue") : t("configuration.card.apply")}
        </button>
        <button className="secondary-button" disabled={busy} onClick={onDismiss} type="button">{t("configuration.card.dismiss")}</button>
        {!showConnectWizard ? <button className="secondary-button conversation-configuration-connect-more" onClick={() => setShowConnectWizard(true)} type="button">{t("configuration.card.connectAnother")}</button> : null}
      </div>
    </div> : null}
    {!models.length || showConnectWizard ? <>
      <p className="conversation-configuration-guidance">{t("configuration.card.connectGuidance")}</p>
      <ModelConnectWizard
        client={client}
        onDefaultModelSet={async (modelId) => {
          const current = await client.getGlobalSettings();
          await client.replaceGlobalSettings({ ...current.overrides, modelId });
        }}
        onModelsChange={onModelsChange}
        onProvidersChange={onProvidersChange}
        onSuccess={(model) => { setConnectedModel(model); void apply(model); }}
        presets={presets}
        proxySettings={proxySettings}
        setFirstModelAsGlobalDefault={firstModelSetup}
      />
      {connectedModel && error ? <button className="secondary-button" disabled={busy} onClick={() => void apply(connectedModel)} type="button">{t("configuration.card.retryBinding")}</button> : null}
      {!models.length ? <button className="conversation-configuration-dismiss" disabled={busy} onClick={onDismiss} type="button">{t("configuration.card.dismiss")}</button> : null}
    </> : null}
    {error ? <p className="conversation-configuration-error" role="alert">{t("configuration.card.bindingFailed")}: {error}</p> : null}
  </section>;
}
