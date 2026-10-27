// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { useEffect, useState } from "react";
import type { ConnectorConfigurationRequest } from "@sciencediscovery/schema";
import { useLocale } from "../i18n/index.js";
import { ConversationalConnectorReceipt } from "./ConversationalConnectorReceipt.js";

export function ConversationalConnectorCard({ request, runActive, onDecision }: {
  request: ConnectorConfigurationRequest;
  runActive: boolean;
  onDecision: (decision: "apply" | "dismiss") => Promise<void>;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!request.autoApplyAt || request.state !== "awaiting_confirmation") return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [request.autoApplyAt, request.state]);
  if (request.state === "applied" || request.state === "stale") {
    return <ConversationalConnectorReceipt request={request} />;
  }
  if (request.state === "dismissed") return null;
  const remainingSeconds = request.autoApplyAt
    ? Math.max(0, Math.ceil((Date.parse(request.autoApplyAt) - now) / 1_000)) : undefined;
  async function decide(decision: "apply" | "dismiss") {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try { await onDecision(decision); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <section aria-label={t("configuration.connector.title")} className="conversation-configuration-card">
    <div className="conversation-configuration-heading">
      <div><span className="eyebrow">{t("configuration.card.eyebrow")}</span><h3>{t("configuration.connector.title")}: {request.connectorName}</h3></div>
      <span className="conversation-configuration-status">{t("configuration.card.awaiting")}</span>
    </div>
    <p>{request.reason === "CONNECTOR_REQUIRED_FOR_TASK"
      ? t("configuration.connector.reason", { name: request.connectorName })
      : request.reason === "USER_REQUESTED_CONNECTOR"
        ? t("configuration.connector.userReason", { name: request.connectorName }) : request.reason}</p>
    <div className="conversation-configuration-impact">
      <span>{t("configuration.connector.change")}</span>
      <strong>{t("configuration.connector.enable", { name: request.connectorName })}</strong>
      <span>{t("configuration.connector.scope")}</span>
      <strong>{t("configuration.card.sessionScope")}</strong>
      <span>{t("configuration.card.continuation")}</span>
      <strong>{t(request.reason === "USER_REQUESTED_CONNECTOR" ? "configuration.connector.userPendingNext"
        : "configuration.connector.currentRun")}</strong>
    </div>
    {request.state === "awaiting_confirmation" && remainingSeconds !== undefined
      ? <p role="status">{remainingSeconds > 0
        ? t("configuration.connector.autoCountdown", { seconds: remainingSeconds })
        : t("configuration.connector.autoDue")}</p> : null}
    {request.state === "awaiting_confirmation" ? <div className="conversation-configuration-actions">
      <button className="primary-button" disabled={busy || runActive} onClick={() => void decide("apply")} type="button">{busy ? t("configuration.card.applying") : t("configuration.connector.confirm")}</button>
      <button className="secondary-button" disabled={busy || runActive} onClick={() => void decide("dismiss")} type="button">{t("configuration.card.dismiss")}</button>
    </div> : null}
    {runActive && request.state === "awaiting_confirmation" ? <p>{t("configuration.connector.waitRun")}</p> : null}
    {error ? <p className="conversation-configuration-error" role="alert">{error}</p> : null}
  </section>;
}
