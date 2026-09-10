// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import { useEffect, useMemo, useState } from "react";
import type { RemoteHostTarget } from "@sciencediscovery/schema";
import type { ApiClient, RunnerWorkspaceBinding } from "./api/client.js";
import { EnvironmentManager } from "./EnvironmentManager.js";
import { useLocale } from "./i18n/index.js";

export function RunnerEnvironmentSettings({ client, onError }: { client: ApiClient; onError: (message: string) => void }) {
  const { t } = useLocale();
  const [hosts, setHosts] = useState<RemoteHostTarget[]>([]);
  const [runnerId, setRunnerId] = useState("local");
  const [tab, setTab] = useState<"environments" | "workspaces">("environments");
  const scopedClient = useMemo(() => client.forEnvironmentRunner(runnerId), [client, runnerId]);
  const host = hosts.find((item) => item.id === runnerId);
  useEffect(() => {
    let disposed = false;
    void client.listRemoteHosts().then((items) => { if (!disposed) setHosts(items); }).catch((error: Error) => { if (!disposed) onError(error.message); });
    return () => { disposed = true; };
  }, [client]);
  return <div className="runner-environment-settings">
    <div className="settings-detail-header"><h3>{t("runnerWorkspaces.title")}</h3><p>{t("runnerWorkspaces.help")}</p></div>
    <label className="settings-field"><span>{t("runnerWorkspaces.runnerLabel")}</span><select aria-label={t("runnerWorkspaces.manageRunnerAria")} value={runnerId} onChange={(event) => setRunnerId(event.target.value)}>
      <option value="local">{t("runnerWorkspaces.localRunner")}</option>
      {hosts.map((item) => <option key={item.id} value={item.id}>{item.runnerName ?? item.alias} · {item.id}</option>)}
    </select></label>
    <div className="runner-management-tabs" role="group" aria-label={t("runnerWorkspaces.tabsAria")}>
      <button type="button" className={tab === "environments" ? "primary-button" : "secondary-button"} onClick={() => setTab("environments")}>{t("runnerWorkspaces.environmentsTab")}</button>
      <button type="button" className={tab === "workspaces" ? "primary-button" : "secondary-button"} onClick={() => setTab("workspaces")}>{t("runnerWorkspaces.workspacesTab")}</button>
    </div>
    {runnerId !== "local" && host?.runnerStatus?.state !== "ready" ? <p role="status">{t("runnerWorkspaces.connectFirst")}</p> : null}
    {tab === "environments" ? <EnvironmentManager key={runnerId} client={scopedClient} compact={runnerId !== "local"} onError={onError} />
      : runnerId === "local" ? <p>{t("runnerWorkspaces.localNote")}</p>
      : <RunnerWorkspaces key={runnerId} client={client} runnerId={runnerId} runnerName={host?.runnerName ?? host?.alias ?? runnerId} />}
  </div>;
}

function RunnerWorkspaces({ client, runnerId, runnerName }: { client: ApiClient; runnerId: string; runnerName: string }) {
  const { t } = useLocale();
  const [items, setItems] = useState<RunnerWorkspaceBinding[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState<string[]>([]);
  async function refresh() {
    setBusy(true); setError("");
    try { setItems(await client.listRunnerWorkspaces(runnerId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t("runnerWorkspaces.loadFailed")); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, [client, runnerId]);
  async function remove(item: RunnerWorkspaceBinding) {
    if (!window.confirm(t("runnerWorkspaces.confirmDelete", { name: `${item.projectName} / ${item.sessionTitle}`, runner: runnerName }))) return;
    setBusy(true); setError("");
    try { await client.deleteRunnerWorkspace(runnerId, item.sessionId); setDeleted((current) => [...current, item.sessionId]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t("runnerWorkspaces.deleteFailed")); }
    finally { setBusy(false); }
  }
  return <section className="remote-workspace-panel">
    <div className="editor-heading"><strong>{t("runnerWorkspaces.remoteTitle")}</strong><button type="button" className="secondary-button" disabled={busy} onClick={() => void refresh()}>{t("runnerWorkspaces.refresh")}</button></div>
    <small>{t("runnerWorkspaces.description")}</small>
    {error ? <div role="alert">{error}</div> : null}
    {!items ? <p>{busy ? t("runnerWorkspaces.loading") : t("runnerWorkspaces.unavailable")}</p> : !items.length ? <p>{t("runnerWorkspaces.empty")}</p> : items.map((item) => <article className="remote-workspace-host" key={item.sessionId}>
      <header><div><strong>{item.sessionTitle}</strong><small>{item.projectName}</small></div><button type="button" className="danger-button" disabled={busy} onClick={() => void remove(item)}>{t("runnerWorkspaces.delete")}</button></header>
      <code>{item.workspaceKey}</code>
      {deleted.includes(item.sessionId) ? <p role="status">{t("runnerWorkspaces.deleted")}</p> : null}
      <details><summary>{t("runnerWorkspaces.transferHistory", { count: item.records.length })}</summary><div className="remote-workspace-records">{item.records.length ? item.records.map((record) => <small key={record.id}>{t("runnerWorkspaces.transferRecord", { agent: record.agentId ? t("runnerWorkspaces.agentId", { id: record.agentId }) : t("runnerWorkspaces.mainAgent"), direction: record.direction, status: record.status, count: record.fileCount, paths: record.paths.join(", "), error: record.error ? ` · ${record.error}` : "" })}</small>) : <small>{t("runnerWorkspaces.noTransfers")}</small>}</div></details>
    </article>)}
  </section>;
}
