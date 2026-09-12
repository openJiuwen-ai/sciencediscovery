// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { RemoteHostTarget } from "@sciencediscovery/schema";
import type { ApiClient, RunnerWorkspaceBinding } from "./api/client.js";
import { EnvironmentManager } from "./EnvironmentManager.js";
import { useLocale } from "./i18n/index.js";

export function RunnerEnvironmentSettings({ client, onError, runnerId, runner, machine }: {
  client: ApiClient; onError: (message: string) => void; runnerId: string; runner?: RemoteHostTarget; machine: ReactNode;
}) {
  const { t } = useLocale();
  const [tab, setTab] = useState<"machine" | "workspaces" | "environments">("machine");
  const scopedClient = useMemo(() => client.forEnvironmentRunner(runnerId), [client, runnerId]);
  const runnerName = runnerId === "local" ? t("remote.localRunner") : runner?.runnerName ?? runner?.alias ?? runnerId;
  const tabs = ["machine", "workspaces", "environments"] as const;
  return <div className="runner-environment-settings">
    <div className="settings-detail-header"><span className="eyebrow">Runner</span><h3>{runnerName}</h3><p>{t("settings.runner.help")}</p></div>
    <div className="runner-management-tabs" role="tablist" aria-label={t("settings.runner.sections")}>
      {tabs.map((item) => <button key={item} id={`runner-tab-${item}`} type="button" role="tab" aria-selected={tab === item} aria-controls={`runner-panel-${item}`} tabIndex={tab === item ? 0 : -1}
        className={tab === item ? "primary-button" : "secondary-button"} onClick={() => setTab(item)}
        onKeyDown={(event) => {
          const index = tabs.indexOf(item);
          const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[2] : undefined;
          if (next) { event.preventDefault(); setTab(next); document.getElementById(`runner-tab-${next}`)?.focus(); }
        }}>{t(`settings.runner.${item}`)}</button>)}
    </div>
    {runner && runner.runnerStatus?.state !== "ready" ? <p role="status">{t("runnerWorkspaces.connectFirst")}</p> : null}
    <div role="tabpanel" id="runner-panel-machine" aria-labelledby="runner-tab-machine" hidden={tab !== "machine"}>{machine}</div>
    {tab === "workspaces" ? <div role="tabpanel" id="runner-panel-workspaces" aria-labelledby="runner-tab-workspaces"><RunnerWorkspaces key={runnerId} client={client} runnerId={runnerId} runnerName={runnerName} /></div> : null}
    {tab === "environments" ? <div role="tabpanel" id="runner-panel-environments" aria-labelledby="runner-tab-environments"><EnvironmentManager key={runnerId} client={scopedClient} compact onError={onError} /></div> : null}
  </div>;
}

function RunnerWorkspaces({ client, runnerId, runnerName }: { client: ApiClient; runnerId: string; runnerName: string }) {
  const { t } = useLocale();
  const [items, setItems] = useState<RunnerWorkspaceBinding[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<Record<string, Array<{ path: string; size: number }>>>({});
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
      <header><div><strong>{item.sessionTitle}</strong><small>{item.projectName}</small></div><div className="remote-host-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => {
        setBusy(true); setError("");
        void client.listRunnerWorkspaceFiles(runnerId, item.sessionId).then((result) => setFiles((current) => ({ ...current, [item.sessionId]: result.files })))
          .catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false));
      }}>{t("runnerCatalog.browseFiles")}</button>
      {runnerId !== "local" ? <button type="button" className="danger-button" disabled={busy} onClick={() => void remove(item)}>{t("runnerWorkspaces.delete")}</button> : null}</div></header>
      <code>{item.workspaceKey}</code>
      {files[item.sessionId] ? <ul className="runner-workspace-files" aria-label={t("runnerCatalog.browseFiles")}>{files[item.sessionId]!.length
        ? files[item.sessionId]!.map((file) => <li key={file.path}><code>{file.path}</code><small>{file.size} B</small></li>)
        : <li>{t("runnerCatalog.emptyFiles")}</li>}</ul> : null}
      {deleted.includes(item.sessionId) ? <p role="status">{t("runnerWorkspaces.deleted")}</p> : null}
      <details><summary>{t("runnerWorkspaces.transferHistory", { count: item.records.length })}</summary><div className="remote-workspace-records">{item.records.length ? item.records.map((record) => <small key={record.id}>{t("runnerWorkspaces.transferRecord", { agent: record.agentId ? t("runnerWorkspaces.agentId", { id: record.agentId }) : t("runnerWorkspaces.mainAgent"), direction: record.direction, status: record.status, count: record.fileCount, paths: record.paths.join(", "), error: record.error ? ` · ${record.error}` : "" })}</small>) : <small>{t("runnerWorkspaces.noTransfers")}</small>}</div></details>
    </article>)}
  </section>;
}
