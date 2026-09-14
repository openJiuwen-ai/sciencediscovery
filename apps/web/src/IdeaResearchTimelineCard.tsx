import { useEffect, useState } from "react";

import type { IdeaResearchView } from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { ideaResearchPhaseLabel, IDEA_RESEARCH_STATUSES } from "./IdeaResearchLabels.js";

/** Compact live progress kept with the conversation that started this research. */
export function IdeaResearchTimelineCard({ client, researchId, sessionId }: { client?: ApiClient; researchId: string; sessionId?: string }) {
  const [view, setView] = useState<IdeaResearchView>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!client || !sessionId) return;
    const controller = new AbortController();
    void client.ideaResearchCommand(sessionId, { operation: "get", researchId })
      .then(setView)
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
    void client.subscribeIdeaResearch(sessionId, researchId, setView, controller.signal)
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => controller.abort();
  }, [client, researchId, sessionId]);

  if (!view) return <aside className="idea-research-timeline-card" aria-live="polite"><strong>Idea Tree 研究已启动</strong><p>{error ?? "正在读取实时进度…"}</p></aside>;
  const research = view.research;
  const activities = (research.activities ?? []).slice(-4);
  return <aside className="idea-research-timeline-card" aria-live="polite">
    <p><strong>Idea Tree 研究</strong> · {IDEA_RESEARCH_STATUSES[research.status] ?? research.status}</p>
    <p>{ideaResearchPhaseLabel(research, research.phase)}{research.currentNodeId ? ` · 节点 ${research.currentNodeId}` : ""}</p>
    <p>第 {research.round} / {research.settings.maxRounds} 轮 · 已完成 {view.graph.nodes.filter(node => node.kind === "candidate" && node.status === "done").length} 个候选</p>
    {activities.length ? <ol>{activities.map((activity, index) => <li key={`${activity.startedAt}-${index}`}>
      {ideaResearchPhaseLabel(research, activity.role)}{activity.nodeId ? ` · 节点 ${activity.nodeId}` : ""} · {{running: "执行中", completed: "已完成", stopped: "已停止", failed: "失败"}[activity.status]}
    </li>)}</ol> : null}
    {error ? <p role="alert">{error}</p> : null}
  </aside>;
}
