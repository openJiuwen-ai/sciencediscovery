// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import { useEffect, useMemo, useState } from "react";
import type { RemoteHostTarget } from "@sciencediscovery/schema";
import type { ApiClient, RunnerWorkspaceBinding } from "./api/client.js";
import { EnvironmentManager } from "./EnvironmentManager.js";

export function RunnerEnvironmentSettings({ client, onError }: { client: ApiClient; onError: (message: string) => void }) {
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
    <div className="settings-detail-header"><h3>Runner environments & workspaces</h3><p>Manage Python/R environments and Session workspaces on each Runner. Project and Session execution choices are unchanged.</p></div>
    <label className="settings-field"><span>Runner</span><select aria-label="Manage Runner" value={runnerId} onChange={(event) => setRunnerId(event.target.value)}>
      <option value="local">Local Runner · local</option>
      {hosts.map((item) => <option key={item.id} value={item.id}>{item.runnerName ?? item.alias} · {item.id}</option>)}
    </select></label>
    <div className="runner-management-tabs" role="group" aria-label="Runner management">
      <button type="button" className={tab === "environments" ? "primary-button" : "secondary-button"} onClick={() => setTab("environments")}>Python / R environments</button>
      <button type="button" className={tab === "workspaces" ? "primary-button" : "secondary-button"} onClick={() => setTab("workspaces")}>Workspaces</button>
    </div>
    {runnerId !== "local" && host?.runnerStatus?.state !== "ready" ? <p role="status">Connect this Runner in Remote compute before installing environments or deleting workspaces.</p> : null}
    {tab === "environments" ? <EnvironmentManager key={runnerId} client={scopedClient} onError={onError} />
      : runnerId === "local" ? <p>Local workspace files are managed in each Session's file panel.</p>
      : <RunnerWorkspaces key={runnerId} client={client} runnerId={runnerId} runnerName={host?.runnerName ?? host?.alias ?? runnerId} />}
  </div>;
}

function RunnerWorkspaces({ client, runnerId, runnerName }: { client: ApiClient; runnerId: string; runnerName: string }) {
  const [items, setItems] = useState<RunnerWorkspaceBinding[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState<string[]>([]);
  async function refresh() {
    setBusy(true); setError("");
    try { setItems(await client.listRunnerWorkspaces(runnerId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load workspaces"); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, [client, runnerId]);
  async function remove(item: RunnerWorkspaceBinding) {
    if (!window.confirm(`Delete every file in “${item.projectName} / ${item.sessionTitle}” on ${runnerName}, including child Agent workspaces? This cannot be undone.`)) return;
    setBusy(true); setError("");
    try { await client.deleteRunnerWorkspace(runnerId, item.sessionId); setDeleted((current) => [...current, item.sessionId]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not delete workspace"); }
    finally { setBusy(false); }
  }
  return <section className="remote-workspace-panel">
    <div className="editor-heading"><strong>Remote workspaces</strong><button type="button" className="secondary-button" disabled={busy} onClick={() => void refresh()}>Refresh workspaces</button></div>
    <small>Session workspace locations registered with this application, including historical use. A location may be empty or not yet created. Files are transferred only by explicit model actions.</small>
    {error ? <div role="alert">{error}</div> : null}
    {!items ? <p>{busy ? "Loading workspaces…" : "Workspaces unavailable."}</p> : !items.length ? <p>No Session workspaces registered for this Runner.</p> : items.map((item) => <article className="remote-workspace-host" key={item.sessionId}>
      <header><div><strong>{item.sessionTitle}</strong><small>{item.projectName}</small></div><button type="button" className="danger-button" disabled={busy} onClick={() => void remove(item)}>Delete remote workspace</button></header>
      <code>{item.workspaceKey}</code>
      {deleted.includes(item.sessionId) ? <p role="status">Workspace deleted. Future execution can recreate this location.</p> : null}
      <details><summary>Transfer history · {item.records.length}</summary><div className="remote-workspace-records">{item.records.length ? item.records.map((record) => <small key={record.id}>{record.agentId ? `Agent ${record.agentId}` : "Main Agent"} · {record.direction} · {record.status} · {record.fileCount} files · {record.paths.join(", ")}{record.error ? ` · ${record.error}` : ""}</small>) : <small>No transfers yet.</small>}</div></details>
    </article>)}
  </section>;
}
