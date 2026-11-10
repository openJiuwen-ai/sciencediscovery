// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useRef, useState, type ComponentType } from "react";
import type { ConnectorConfigurationRequest } from "@sciencediscovery/schema";
import type { ConfigurationProcessRecordProps } from "@sciencediscovery/configuration-ui";
import { TEXT } from "../text.js";

interface Props {
  request: ConnectorConfigurationRequest;
  readOnly: boolean;
  runActive: boolean;
  onDecision: (decision: "apply" | "dismiss") => Promise<void>;
  onRefresh: () => Promise<void>;
  ProcessRecord: ComponentType<ConfigurationProcessRecordProps>;
}

/** Display historical records without inventing a generic revision, preview or
 * approval. Only the server may decide or resume the original request. */
export function LegacyConnectorConfigurationCard({ request, readOnly, runActive, onDecision, onRefresh, ProcessRecord }: Props) {
  const m = TEXT.configurationLegacy;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const scheduled = request.state === "awaiting_confirmation" && request.autoApplyAt
    && Number.isFinite(Date.parse(request.autoApplyAt)) ? Date.parse(request.autoApplyAt) : undefined;
  useEffect(() => {
    if (scheduled === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [scheduled]);
  const disabled = readOnly || runActive || busy || failed;
  async function decide(decision: "apply" | "dismiss") {
    if (disabled || busyRef.current || request.state !== "awaiting_confirmation") return;
    busyRef.current = true; setBusy(true);
    try { await onDecision(decision); }
    catch { if (mounted.current) setFailed(true); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  async function refresh() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await onRefresh(); if (mounted.current) setFailed(false); }
    catch { /* The last decision's outcome stays uncertain until a read succeeds. */ }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  const impact = <dl className="configuration-impact">
    <dt>{m.change}</dt><dd>{m.enable(request.connectorName)}</dd>
    <dt>{m.scope}</dt><dd>{m.session}</dd>
    <dt>{m.continuation}</dt><dd>{request.runId.startsWith("user-request:") ? m.noTask
      : request.continuationRunId ? m.recorded : m.serverOwned}</dd>
  </dl>;
  if (request.state !== "awaiting_confirmation") {
    const state = request.state === "applied" ? m.saved : request.state === "dismissed" ? m.dismissed : m.stale;
    return <ProcessRecord className="conversation-configuration-record" label={`${state} · ${request.connectorName}`}>
      <section aria-label={m.title} className="conversation-configuration-record-details">
        {request.state === "applied" ? impact : <p>{request.state === "dismissed" ? m.dismissedDetail : m.staleDetail}</p>}
      </section>
    </ProcessRecord>;
  }
  const remaining = scheduled === undefined ? undefined : Math.max(0, Math.ceil((scheduled - now) / 1_000));
  return <section aria-label={m.title} className="conversation-configuration-card" id={`configuration-request-${request.id}`}>
    <div className="conversation-configuration-heading"><div><h3>{m.title}: {request.connectorName}</h3></div><span className="conversation-configuration-status">{m.awaiting}</span></div>
    <p>{request.reason === "USER_REQUESTED_CONNECTOR" ? m.userReason(request.connectorName)
      : request.reason === "CONNECTOR_REQUIRED_FOR_TASK" ? m.taskReason(request.connectorName) : request.reason}</p>
    {impact}
    {remaining !== undefined ? <p className="configuration-auto-apply" role="status">{remaining > 0 ? m.countdown(remaining) : m.due}</p> : null}
    <div className="conversation-configuration-actions">
      <button className="primary-button" disabled={disabled} onClick={() => void decide("apply")} type="button">{busy ? m.saving : m.confirm}</button>
      <button disabled={disabled} onClick={() => void decide("dismiss")} type="button">{m.decline}</button>
    </div>
    {runActive ? <p>{m.waitRun}</p> : null}
    {failed ? <div className="conversation-configuration-error" role="alert"><p>{m.failed}</p>
      <button disabled={busy} onClick={() => void refresh()} type="button">{m.refresh}</button></div> : null}
  </section>;
}
