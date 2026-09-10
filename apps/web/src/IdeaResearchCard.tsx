import { useCallback, useEffect, useRef, useState } from "react";
import type { IdeaResearchView } from "@sciencediscovery/schema";
import type { ApiClient } from "./api.js";
import { IdeaTreeExplorer } from "./IdeaTreeExplorer.js";

const phases: Record<string, string> = {ideate: "构思方向与改进", design: "设计候选", activity: "活性评估", stability: "稳定性评估", sustainability: "可持续性评估", aggregate: "聚合评估", propagate: "汇总研究发现", complete: "已完成"};
const statuses: Record<string, string> = {running: "运行中", pausing: "正在暂停", paused: "已暂停", interrupted: "已中断", completed: "已完成", ended: "已结束"};

export function IdeaResearchCard({client, sessionId, onError}: {client: ApiClient; sessionId: string; onError: (message: string) => void}) {
  const element = useRef<HTMLElement>(null);
  const [items, setItems] = useState<IdeaResearchView[]>([]);
  const [selected, setSelected] = useState<string>();
  const [open, setOpen] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState<string>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try { const result = await client.listIdeaResearch(sessionId); setItems(result.items); setError(undefined); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [client, sessionId]);
  useEffect(() => { void load(); }, [load]);
  const activeId = items.find(i => ["running", "pausing"].includes(i.research.status))?.research.id;
  const [reconnect, setReconnect] = useState(0);
  useEffect(() => {
    if (!activeId) return;
    const controller = new AbortController();
    void client.subscribeIdeaResearch(sessionId, activeId, incoming => {
      setItems(current => current.map(item => item.research.id === incoming.research.id ? incoming : item));
      setError(undefined);
    }, controller.signal).catch(e => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    });
    const tick = setInterval(() => setClock(Date.now()), 1000);
    return () => { controller.abort(); clearInterval(tick); };
  }, [activeId, client, sessionId, reconnect]);
  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<{sessionId: string}>).detail.sessionId === sessionId) {
        setSelected(undefined);
        void load();
        element.current?.scrollIntoView({block: "nearest"});
      }
    };
    window.addEventListener("idea-research-updated", refresh);
    return () => window.removeEventListener("idea-research-updated", refresh);
  }, [load, sessionId]);
  async function command(operation: string, researchId: string) {
    setBusy(true);
    try {
      await client.ideaResearchCommand(sessionId, {operation, researchId});
      setConfirmEnd(undefined); await load();
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally {setBusy(false);}
  }
  const view = items.find(i => i.research.id === selected) ?? items[0];
  if (!view) return null;
  const r = view.research;
  return <section ref={element} className="idea-research-panel" aria-label="Idea Tree 研究控制">
    {error && <p role="alert">{error} <button type="button" onClick={() => { void load(); setReconnect(n => n + 1); }}>重新连接</button></p>}
    <button className="idea-tree-view" type="button" onClick={() => setOpen(true)}>
      <span className="idea-tree-view-header"><strong>Idea Tree</strong><em>{statuses[r.status]}</em></span>
      <span className="idea-tree-view-objective">{r.objective}</span>
      <span className="idea-tree-view-stats">第 {r.round} / {r.settings.maxRounds} 轮 · {view.graph.nodes.filter(n => n.kind === "candidate" && n.status === "done").length} 个候选已完成</span>
      <span className="idea-tree-view-stats">{r.activities?.filter(a => a.status === "running").map(a => phases[a.role] ?? a.role).join(" · ") || phases[r.phase] || r.phase}</span>
      <span className="idea-tree-view-action">查看研究进度 →</span>
    </button>
    {open && <IdeaTreeExplorer autonomous graph={view.graph} treeIds={items.map(i => i.research.id)} onClose={() => setOpen(false)} onSelectTree={setSelected}
      controls={<div className="idea-research-progress">
        <p>{statuses[r.status]} · 第 {r.round} / {r.settings.maxRounds} 轮 · 本轮完成 {r.batchCompleted} / {r.batch.length || r.batchCompleted}</p>
        <p>{phases[r.phase] ?? r.phase} · 已评估 {view.graph.nodes.filter(n => n.kind === "candidate" && n.status === "done").length} 个候选 · tokens {r.usageKnown ? r.tokens : `${r.tokens}（部分用量未知）`}</p>
        {r.reason && <p>{r.reason}</p>}
        <ol aria-label="研究执行进度">
          {(r.activities ?? []).slice(-12).map((activity, index) => <li key={`${activity.startedAt}-${activity.role}-${index}`}>
            {phases[activity.role] ?? activity.role}{activity.nodeId ? ` · 节点 ${activity.nodeId}` : ""} · {{running: "执行中", completed: "已完成", stopped: "已停止", failed: "失败"}[activity.status]}
            {" · "}{Math.max(0, Math.round(((activity.finishedAt ? Date.parse(activity.finishedAt) : clock) - Date.parse(activity.startedAt)) / 1000))} 秒
            {activity.error && <p role="alert">{activity.error}</p>}
          </li>)}
        </ol>
        <div className="idea-research-actions">
          {r.status === "running" && <button className="secondary-button" type="button" disabled={busy} onClick={() => void command("pause", r.id)}>暂停</button>}
          {["paused", "interrupted"].includes(r.status) && <button className="secondary-button" type="button" disabled={busy} onClick={() => void command("continue", r.id)}>继续</button>}
          {!["completed", "ended"].includes(r.status) && <button className="secondary-button" type="button" disabled={busy} onClick={() => setConfirmEnd(r.id)}>结束研究</button>}
        </div>
        {confirmEnd === r.id && <div role="alert">结束后不能继续，已有结果会保留。<div className="idea-research-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => void command("end", r.id)}>确认结束</button><button className="secondary-button" type="button" onClick={() => setConfirmEnd(undefined)}>取消</button></div></div>}
      </div>} />}
  </section>;
}
