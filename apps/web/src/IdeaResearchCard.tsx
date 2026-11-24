import { useCallback, useEffect, useRef, useState } from "react";
import type { IdeaResearchView } from "@sciencediscovery/schema";
import type { ApiClient } from "./api.js";
import { isAuthFailure } from "./api/auth.js";
import { IdeaTreeExplorer } from "./IdeaTreeExplorer.js";
import { useLocale } from "./i18n/index.js";
import { ideaResearchActivityStatusLabel, ideaResearchPhaseLabel, ideaResearchStatusLabel } from "./IdeaResearchLabels.js";

/** How often an empty list is re-read while a research is expected. */
const EMPTY_POLL_MS = 5_000;
/** How long that re-read keeps going before the card accepts "nothing started". */
const EMPTY_POLL_WINDOW_MS = 5 * 60_000;

export function IdeaResearchCard({client, sessionId, onError, onResearchAvailability}: {client: ApiClient; sessionId: string; onError: (reason: string | Error) => void; onResearchAvailability?: (available: boolean) => void}) {
  const { t } = useLocale();
  const element = useRef<HTMLElement>(null);
  const [items, setItems] = useState<IdeaResearchView[]>([]);
  const [selected, setSelected] = useState<string>();
  const [open, setOpen] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState<string>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try { const result = await client.listIdeaResearch(sessionId); setItems(result.items); setError(undefined); onResearchAvailability?.(result.items.length > 0); }
    catch (e) { setError(isAuthFailure(e) ? undefined : e instanceof Error ? e.message : String(e)); }
  }, [client, sessionId, onResearchAvailability]);
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
  /**
   * While this Session has no research at all, re-read the list on a slow timer.
   *
   * The created event only reaches a client that is listening at that moment: a
   * reload, a reconnect, or a stream that attached late all miss it, and the run
   * stream does not replay it. Without this the card for the research the
   * command started would never appear until something else refreshed the
   * Session — which is exactly how the real L4 journey failed: the command ran,
   * the research existed, and the card stayed absent for its whole wait.
   *
   * Bounded, so an idle Session that never starts a research makes no requests
   * for long: the timer stops once an item appears or the window is spent.
   */
  useEffect(() => {
    if (items.length > 0) return undefined;
    const started = Date.now();
    // Bare `setInterval`, like the SSE clock above: this file is a browser
    // component, and a test harness that stubs `window` should not have to stub
    // its timers as well.
    const timer = setInterval(() => {
      if (Date.now() - started > EMPTY_POLL_WINDOW_MS) {
        clearInterval(timer);
        return;
      }
      void load();
    }, EMPTY_POLL_MS);
    return () => clearInterval(timer);
  }, [items.length, load]);

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
    } catch (e) { onError(e instanceof Error ? e : String(e)); }
    finally {setBusy(false);}
  }
  const view = items.find(i => i.research.id === selected) ?? items[0];
  if (!view) return error ? <p role="alert">{error} <button className="secondary-button compact-button" type="button" onClick={() => void load()}>{t("ideaResearch.retry")}</button></p> : null;
  const r = view.research;
  return <section ref={element} className="idea-research-panel" aria-label={t("ideaResearch.controlsAria")}>
    {error && <p role="alert">{error} <button className="secondary-button compact-button" type="button" onClick={() => { void load(); setReconnect(n => n + 1); }}>{t("ideaResearch.reconnect")}</button></p>}
    <button className="idea-tree-view" type="button" onClick={() => setOpen(true)}>
      <span className="idea-tree-view-header"><strong>Idea Tree</strong><em>{ideaResearchStatusLabel(t, r.status)}</em></span>
      <span className="idea-tree-view-objective">{r.objective}</span>
      <span className="idea-tree-view-stats">{t("ideaResearch.round", {round: r.round, total: r.settings.maxRounds})} · {t("ideaResearch.candidatesDone", {count: view.graph.nodes.filter(n => n.kind === "candidate" && n.status === "done").length})}</span>
      <span className="idea-tree-view-stats">{r.activities?.filter(a => a.status === "running").map(a => ideaResearchPhaseLabel(t, r, a.role)).join(" · ") || ideaResearchPhaseLabel(t, r, r.phase)}</span>
      <span className="idea-tree-view-action">{t("ideaResearch.viewProgress")}</span>
    </button>
    {open && <IdeaTreeExplorer autonomous graph={view.graph} treeIds={items.map(i => i.research.id)} onClose={() => setOpen(false)} onSelectTree={setSelected}
      controls={<div className="idea-research-progress">
        <p>{ideaResearchStatusLabel(t, r.status)} · {t("ideaResearch.round", {round: r.round, total: r.settings.maxRounds})} · {t("ideaResearch.batchProgress", {completed: r.batchCompleted, total: r.batch.length || r.batchCompleted})}</p>
        {r.unreportedBudgetEstimate ? <p>{t("ideaResearch.unreportedBudgetEstimate", { count: r.unreportedBudgetEstimate })}</p> : null}
        <p>{ideaResearchPhaseLabel(t, r, r.phase)} · {t("ideaResearch.candidatesEvaluated", {count: view.graph.nodes.filter(n => n.kind === "candidate" && n.status === "done").length})} · {t(r.usageKnown ? "ideaResearch.tokens" : "ideaResearch.tokensPartial", {count: r.tokens})}</p>
        {r.reason && <p>{r.reason}</p>}
        <ol aria-label={t("ideaResearch.progressAria")}>
          {(r.activities ?? []).slice(-12).map((activity, index) => <li key={`${activity.startedAt}-${activity.role}-${index}`}>
            {ideaResearchPhaseLabel(t, r, activity.role)}{activity.nodeId ? ` · ${t("ideaResearch.node", {id: activity.nodeId})}` : ""} · {ideaResearchActivityStatusLabel(t, activity.status)}
            {" · "}{t("ideaResearch.duration", {seconds: Math.max(0, Math.round(((activity.finishedAt ? Date.parse(activity.finishedAt) : clock) - Date.parse(activity.startedAt)) / 1000))})}
            {activity.error && <p role="alert">{activity.error}</p>}
          </li>)}
        </ol>
        <div className="idea-research-actions">
          {r.status === "running" && <button className="secondary-button" type="button" disabled={busy} onClick={() => void command("pause", r.id)}>{t("ideaResearch.pause")}</button>}
          {["paused", "interrupted"].includes(r.status) && <button className="secondary-button" type="button" disabled={busy} onClick={() => void command("continue", r.id)}>{t("ideaResearch.continue")}</button>}
          {!["completed", "ended"].includes(r.status) && <button className="secondary-button" type="button" disabled={busy} onClick={() => setConfirmEnd(r.id)}>{t("ideaResearch.end")}</button>}
        </div>
        {confirmEnd === r.id && <div role="alert">{t("ideaResearch.endWarning")}<div className="idea-research-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => void command("end", r.id)}>{t("ideaResearch.endConfirm")}</button><button className="secondary-button" type="button" onClick={() => setConfirmEnd(undefined)}>{t("ideaResearch.endCancel")}</button></div></div>}
      </div>} />}
  </section>;
}
