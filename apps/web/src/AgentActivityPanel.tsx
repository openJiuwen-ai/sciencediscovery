// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useState } from "react";
import type { ApiClient } from "./api.js";
import type { AgentActivity } from "./api/runs.js";

const active = (state: string) => ["queued", "running", "unknown"].includes(state);
export function AgentActivityPanel({ client, sessionId }: { client: ApiClient; sessionId: string }) {
  const [activity, setActivity] = useState<AgentActivity>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<{ id: string; text: string }>();
  useEffect(() => {
    let disposed = false; let pending = false;
    setActivity(undefined); setLogs(undefined); setError("");
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try { const next = await client.getAgentActivity(sessionId); if (!disposed) { setActivity(next); setError(""); } }
      catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : "Could not load activity"); }
      finally { pending = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [client, sessionId]);
  async function action(operation: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await operation(); setActivity(await client.getAgentActivity(sessionId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Activity action failed"); }
    finally { setBusy(false); }
  }
  return <details className="workspace-fold agent-activity" aria-label="Executions and reminders">
    <summary><strong>Executions & reminders</strong><span>{activity?.executions.filter((item) => active(item.state)).length ?? 0} active</span></summary>
    <div className="workspace-fold-body">
      {error ? <p role="alert">{error}</p> : null}
      {!activity ? <p>Loading activity…</p> : <>
        <h4>Executions</h4>
        {!activity.executions.length ? <p>No executions yet.</p> : activity.executions.toReversed().map((item) => <article key={item.id}>
          <header><strong>{item.runnerId} · {item.agentId}</strong><span className={`activity-badge ${item.state}`}>{item.state}</span></header>
          <code>{item.id}</code><small>Workspace {item.workspaceId} · provenance {item.provenance}</small>
          {item.error ? <p role="alert">{item.error}</p> : null}
          <div className="activity-actions"><button type="button" disabled={busy} onClick={() => void action(async () => {
            const result = await client.executionLogs(sessionId, item.id);
            setLogs({ id: item.id, text: result.chunks.map((chunk) => chunk.text).join("").slice(-20000) || "No output yet." });
          })}>View logs</button><button type="button" disabled={busy || !active(item.state)} onClick={() => void action(() => client.cancelActivity(sessionId, "executions", item.id))}>Cancel execution</button></div>
          {logs?.id === item.id ? <pre aria-label="Execution logs">{logs.text}</pre> : null}
        </article>)}
        <h4>Transfers</h4>
        {!activity.transfers.length ? <p>No transfers yet.</p> : activity.transfers.map((item) => <article key={item.id}>
          <header><strong>{item.sourceWorkspaceId} → {item.targetWorkspaceId}</strong><span className={`activity-badge ${item.state}`}>{item.state}</span></header>
          <small>{item.progress.filter((file) => file.state === "completed").length}/{item.files.length} files committed</small>
          {item.error ? <p role="alert">{item.error}</p> : null}
          <details><summary>File progress</summary>{item.progress.map((file) => <small key={file.targetPath}>{file.targetPath} · {file.state} · {file.bytes} bytes</small>)}</details>
          <button type="button" disabled={busy || !["queued", "running"].includes(item.state)} onClick={() => void action(() => client.cancelActivity(sessionId, "transfers", item.id))}>Cancel transfer</button>
        </article>)}
        <h4>Reminders</h4>
        {!activity.timers.length ? <p>No reminders yet.</p> : activity.timers.map((item) => <article key={item.id}>
          <header><strong>{item.message}</strong><span className={`activity-badge ${item.state}`}>{item.state}</span></header>
          <small>{item.agentId} · {new Date(item.dueAt).toLocaleString()}</small>
          <button type="button" disabled={busy || item.state !== "pending"} onClick={() => void action(() => client.cancelActivity(sessionId, "timers", item.id))}>Cancel reminder</button>
        </article>)}
        {activity.agents.filter((item) => item.stopped && item.agentId.startsWith("subagent:")).map((item) => <button key={item.agentId} type="button" disabled={busy} onClick={() => void action(() => client.resumeSubagent(sessionId, item.agentId.slice(9)))}>Resume {item.agentId}</button>)}
      </>}
    </div>
  </details>;
}
