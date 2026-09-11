// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useState } from "react";
import type { ApiClient } from "./api.js";
import type { AgentActivity } from "./api/runs.js";
import { ProcessRecord } from "./ProcessRecord.js";
import { useLocale } from "./i18n/index.js";
import { ChevronRightIcon } from "./icons.js";

const active = (state: string) => ["queued", "running", "unknown"].includes(state);
export function AgentActivityPanel({ client, sessionId }: { client: ApiClient; sessionId: string }) {
  const { t } = useLocale();
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
      catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : t("activity.loadFailed")); }
      finally { pending = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [client, sessionId]);
  async function action(operation: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await operation(); setActivity(await client.getAgentActivity(sessionId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t("activity.actionFailed")); }
    finally { setBusy(false); }
  }
  return <div className="agent-activity" aria-label={t("activity.sectionAria")}>
    {error ? <p role="alert">{error}</p> : null}
    {!activity && !error ? <p>{t("activity.loading")}</p> : null}
    {activity && activity.executions.length > 0 ? <details className="workspace-fold">
    <summary><ChevronRightIcon className="fold-chevron" size={15} /><strong>{t("activity.executions")}</strong><span className="fold-meta">{activity.executions.length}</span></summary>
    <div className="workspace-fold-body">
      {!activity ? <p>{t("activity.loading")}</p> : <>
        {!activity.executions.length ? <p>{t("activity.noExecutions")}</p> : activity.executions.toReversed().map((item) => <ProcessRecord key={item.id} active={active(item.state)} failed={item.state === "failed"} label={`${item.runnerId} · ${item.agentId} · ${item.state}`}><article>
          <header><strong>{item.runnerId} · {item.agentId}</strong><span className={`activity-badge ${item.state}`}>{item.state}</span></header>
          <code>{item.id}</code><small>{t("activity.executionMeta", { provenance: item.provenance, workspace: item.workspaceId })}</small>
          {item.error ? <p role="alert">{item.error}</p> : null}
          <div className="activity-actions"><button type="button" disabled={busy} onClick={() => void action(async () => {
            const result = await client.executionLogs(sessionId, item.id);
            setLogs({ id: item.id, text: result.chunks.map((chunk) => chunk.text).join("").slice(-20000) || t("activity.noOutput") });
          })}>{t("activity.viewLogs")}</button><button type="button" disabled={busy || !active(item.state)} onClick={() => void action(() => client.cancelActivity(sessionId, "executions", item.id))}>{t("activity.cancelExecution")}</button></div>
          {logs?.id === item.id ? <pre aria-label={t("activity.logsAria")}>{logs.text}</pre> : null}
        </article></ProcessRecord>)}
      </>}
    </div></details> : null}
    {activity && activity.transfers.length > 0 ? <details className="workspace-fold"><summary><ChevronRightIcon className="fold-chevron" size={15} /><strong>{t("activity.transfers")}</strong><span className="fold-meta">{activity.transfers.length}</span></summary><div className="workspace-fold-body">
      {!activity ? <p>{t("activity.loading")}</p> : <>
        {!activity.transfers.length ? <p>{t("runnerWorkspaces.noTransfers")}</p> : activity.transfers.map((item) => <ProcessRecord key={item.id} active={active(item.state)} failed={item.state === "failed"} label={`${item.sourceWorkspaceId} → ${item.targetWorkspaceId} · ${item.state}`}><article>
          <header><strong>{item.sourceWorkspaceId} → {item.targetWorkspaceId}</strong><span className={`activity-badge ${item.state}`}>{item.state}</span></header>
          <small>{t("activity.filesCommitted", { committed: item.progress.filter((file) => file.state === "completed").length, total: item.files.length })}</small>
          {item.error ? <p role="alert">{item.error}</p> : null}
          <details><summary>{t("activity.fileProgress")}</summary>{item.progress.map((file) => <small key={file.targetPath}>{file.targetPath} · {file.state} · {t("downloads.bytes", { count: file.bytes })}</small>)}</details>
          <button type="button" disabled={busy || !["queued", "running"].includes(item.state)} onClick={() => void action(() => client.cancelActivity(sessionId, "transfers", item.id))}>{t("activity.cancelTransfer")}</button>
        </article></ProcessRecord>)}
      </>}
    </div></details> : null}
    {activity && activity.timers.length > 0 ? <details className="workspace-fold"><summary><ChevronRightIcon className="fold-chevron" size={15} /><strong>{t("activity.reminders")}</strong><span className="fold-meta">{activity.timers.length}</span></summary><div className="workspace-fold-body">
      {!activity ? <p>{t("activity.loading")}</p> : <>
        {!activity.timers.length ? <p>{t("activity.noReminders")}</p> : activity.timers.map((item) => <ProcessRecord key={item.id} active={item.state === "pending"} failed={false} label={`${item.message} · ${item.state}`}><article>
          <header><strong>{item.message}</strong><span className={`activity-badge ${item.state}`}>{item.state}</span></header>
          <small>{item.agentId} · {new Date(item.dueAt).toLocaleString()}</small>
          <button type="button" disabled={busy || item.state !== "pending"} onClick={() => void action(() => client.cancelActivity(sessionId, "timers", item.id))}>{t("activity.cancelReminder")}</button>
        </article></ProcessRecord>)}
      </>}
    </div>
    </details> : null}
    {activity?.agents.filter((item) => item.stopped && item.agentId.startsWith("subagent:")).map((item) => <button key={item.agentId} type="button" disabled={busy} onClick={() => void action(() => client.resumeSubagent(sessionId, item.agentId.slice(9)))}>{t("activity.resumeAgent", { id: item.agentId })}</button>)}
  </div>;
}
