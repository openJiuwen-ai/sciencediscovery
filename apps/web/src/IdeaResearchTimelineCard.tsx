import { useEffect, useState } from "react";

import type { IdeaResearchView } from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { useLocale } from "./i18n/index.js";
import { ideaResearchActivityStatusLabel, ideaResearchPhaseLabel, ideaResearchStatusLabel } from "./IdeaResearchLabels.js";

/** Compact live progress kept with the conversation that started this research. */
export function IdeaResearchTimelineCard({ client, researchId, sessionId }: { client?: ApiClient; researchId: string; sessionId?: string }) {
  const { t } = useLocale();
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

  if (!view) return <aside className="idea-research-timeline-card" aria-live="polite"><strong>{t("ideaResearch.started")}</strong><p>{error ?? t("ideaResearch.loadingProgress")}</p></aside>;
  const research = view.research;
  const activities = (research.activities ?? []).slice(-4);
  return <aside className="idea-research-timeline-card" aria-live="polite">
    <p><strong>{t("ideaResearch.title")}</strong> · {ideaResearchStatusLabel(t, research.status)}</p>
    <p>{ideaResearchPhaseLabel(t, research, research.phase)}{research.currentNodeId ? ` · ${t("ideaResearch.node", {id: research.currentNodeId})}` : ""}</p>
    <p>{t("ideaResearch.round", {round: research.round, total: research.settings.maxRounds})} · {t("ideaResearch.candidatesDone", {count: view.graph.nodes.filter(node => node.kind === "candidate" && node.status === "done").length})}</p>
    {activities.length ? <ol>{activities.map((activity, index) => <li key={`${activity.startedAt}-${index}`}>
      {ideaResearchPhaseLabel(t, research, activity.role)}{activity.nodeId ? ` · ${t("ideaResearch.node", {id: activity.nodeId})}` : ""} · {ideaResearchActivityStatusLabel(t, activity.status)}
    </li>)}</ol> : null}
    {error ? <p role="alert">{error}</p> : null}
  </aside>;
}
