import { useCallback, useEffect, useRef, useState } from "react";
import type { IdeaResearchView } from "@sciencediscovery/schema";
import type { ApiClient } from "./api.js";
import { IdeaTreeExplorer } from "./IdeaTreeExplorer.js";

const phases: Record<string, string> = {ideate: "构思方向与改进", design: "设计候选", activity: "活性评估", stability: "稳定性评估", sustainability: "可持续性评估", aggregate: "聚合评估", propagate: "汇总研究发现", complete: "已完成"};
const statuses: Record<string, string> = {running: "运行中", pausing: "正在暂停", paused: "已暂停", interrupted: "已中断", completed: "已完成", ended: "已结束"};

export function IdeaResearchPanel({client, sessionId, onError}: {client: ApiClient; sessionId: string; onError: (message: string) => void}) {
  const element = useRef<HTMLElement>(null);
  const [items, setItems] = useState<IdeaResearchView[]>([]);
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState<string>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try { const result = await client.listIdeaResearch(sessionId); setItems(result.items); setError(undefined); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [client, sessionId]);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 5000); return () => clearInterval(timer); }, [load]);
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
    {error && <p role="alert">{error} <button type="button" onClick={() => void load()}>重试</button></p>}
    <IdeaTreeExplorer autonomous embedded graph={view.graph} treeIds={items.map(i => i.research.id)} onClose={() => {}} onSelectTree={setSelected}
      controls={<div className="idea-research-progress">
        <p>{statuses[r.status]} · 第 {r.round} / {r.settings.maxRounds} 轮 · 本轮完成 {r.batchCompleted} / {r.batch.length || r.batchCompleted}</p>
        <p>{phases[r.phase] ?? r.phase} · 已评估 {view.graph.nodes.filter(n => n.kind === "candidate" && n.status === "done").length} 个候选 · tokens {r.usageKnown ? r.tokens : `${r.tokens}（部分用量未知）`}</p>
        {r.reason && <p>{r.reason}</p>}
        <div className="idea-research-actions">
          {r.status === "running" && <button className="secondary-button" type="button" disabled={busy} onClick={() => void command("pause", r.id)}>暂停</button>}
          {["paused", "interrupted"].includes(r.status) && <button className="secondary-button" type="button" disabled={busy} onClick={() => void command("continue", r.id)}>继续</button>}
          {!["completed", "ended"].includes(r.status) && <button className="secondary-button" type="button" disabled={busy} onClick={() => setConfirmEnd(r.id)}>结束研究</button>}
        </div>
        {confirmEnd === r.id && <div role="alert">结束后不能继续，已有结果会保留。<div className="idea-research-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => void command("end", r.id)}>确认结束</button><button className="secondary-button" type="button" onClick={() => setConfirmEnd(undefined)}>取消</button></div></div>}
      </div>} />
  </section>;
}
