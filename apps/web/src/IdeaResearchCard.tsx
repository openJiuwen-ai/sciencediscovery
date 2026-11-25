import { useCallback, useEffect, useRef, useState } from "react";
import type { IdeaResearchView } from "@sciencediscovery/schema";
import type { ApiClient } from "./api.js";
import { isAuthFailure } from "./api/auth.js";
import { IDEA_RESEARCH_EXPECTED_EVENT } from "./ideaResearchNotice.js";
import { IdeaTreeExplorer } from "./IdeaTreeExplorer.js";
import { useLocale } from "./i18n/index.js";
import { ideaResearchActivityStatusLabel, ideaResearchPhaseLabel, ideaResearchStatusLabel } from "./IdeaResearchLabels.js";

/** How often an empty list is re-read while a research is expected. */
const EMPTY_POLL_MS = 5_000;
/** The slower cadence the same re-read falls back to once the wait is clearly long. */
const EMPTY_POLL_SLOW_MS = 30_000;
/** How long the fast cadence lasts before the slow one takes over. */
const EMPTY_POLL_FAST_FOR_MS = 2 * 60_000;
/**
 * How long that re-read keeps going before the card accepts "nothing started".
 *
 * As long as the journey itself gives a research to be created
 * (`CREATE_BUDGET_MS` in `test/journey-idea-tree-real.spec.ts` is 600s, and a
 * measured run created its research at 403s): a card that stopped asking after
 * five minutes would leave a Session blank for the rest of a slow start, which
 * is the bug this poll exists to fix.
 */
const EMPTY_POLL_WINDOW_MS = 10 * 60_000;

function keepLatestView(incoming: IdeaResearchView, current?: IdeaResearchView): IdeaResearchView {
  // Both snapshots carry the evolve store's UTC ISO timestamp. Compare the strings
  // directly to preserve microseconds when a list response races a stream update.
  return current && current.graph.updatedAt > incoming.graph.updatedAt ? current : incoming;
}

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
  /**
   * When this card first saw an empty list, and when it last learned that a
   * research may be on its way (`armIdeaResearchCard`: an `/idea-tree` command
   * this client sent, or an attach to a run whose replay carried one). The
   * re-read runs while either anchor is inside its window and the later one wins,
   * because a Session can stay open for hours before the command arrives: a
   * window anchored at mount alone would already be spent by then.
   */
  const emptySince = useRef<number | null>(null);
  const expectSince = useRef<number | null>(null);
  /** How many researches the list held when the expectation was announced. */
  const expectCount = useRef(0);
  /** Restarts the re-read chain, so a command can open a window after an idle spell. */
  const kick = useRef<() => void>(() => undefined);
  /** Latest availability callback, held in a ref so `load` keeps one identity. */
  const announce = useRef(onResearchAvailability);
  announce.current = onResearchAvailability;
  const load = useCallback(async () => {
    try {
      const result = await client.listIdeaResearch(sessionId);
      setItems(current => {
        const byId = new Map(current.map(item => [item.research.id, item]));
        return result.items.map(incoming => keepLatestView(incoming, byId.get(incoming.research.id)));
      });
      // An item closes the window that was opened for an empty list, so a Session
      // that already has a research is not re-read for the rest of the card's
      // life. An expectation is spent once the list has grown past what it held
      // when the announcement arrived: the research it was waiting for is drawn,
      // so there is nothing left to ask for.
      if (result.items.length > 0) emptySince.current = null;
      if (expectSince.current !== null && result.items.length > expectCount.current) expectSince.current = null;
      setError(undefined);
      announce.current?.(result.items.length > 0);
    }
    catch (e) { setError(isAuthFailure(e) ? undefined : e instanceof Error ? e.message : String(e)); }
  }, [client, sessionId]);
  const loadRef = useRef(load);
  loadRef.current = load;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => { void load(); }, [load]);
  const activeId = items.find(i => ["running", "pausing"].includes(i.research.status))?.research.id;
  const [reconnect, setReconnect] = useState(0);
  useEffect(() => {
    if (!activeId) return;
    const controller = new AbortController();
    void client.subscribeIdeaResearch(sessionId, activeId, incoming => {
      setItems(current => current.map(item => item.research.id === incoming.research.id ? keepLatestView(incoming, item) : item));
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
   * Bounded, so an idle Session that never starts a research does not ask
   * forever: five seconds at first, thirty once the wait is clearly long, and
   * nothing at all once an item appears or the window is spent.
   */
  useEffect(() => {
    if (emptySince.current === null && expectSince.current === null) emptySince.current = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Bare `setTimeout`, like the SSE clock above: this file is a browser
    // component, and a test harness that stubs `window` should not have to stub
    // its timers as well. A chain rather than a fixed interval, so the cadence
    // can slow down without a second timer, and installed once for the card's
    // life so a parent's re-render cannot restart the window.
    const schedule = (ms: number) => { timer = setTimeout(tick, ms); };
    const tick = () => {
      const started = Math.max(emptySince.current ?? Number.NEGATIVE_INFINITY, expectSince.current ?? Number.NEGATIVE_INFINITY);
      const now = Date.now();
      const waiting = Number.isFinite(started) && now - started <= EMPTY_POLL_WINDOW_MS;
      // Nothing left to wait for: the chain ends here rather than idling on a
      // timer for the rest of the card's life. `kick` restarts it when a command
      // or an attach opens a new window.
      if (!waiting) return;
      void loadRef.current();
      schedule(now - started < EMPTY_POLL_FAST_FOR_MS ? EMPTY_POLL_MS : EMPTY_POLL_SLOW_MS);
    };
    // A command, or an attach to a run, restarts the chain: the window it opens
    // must be read within seconds even if the previous one was spent.
    kick.current = () => {
      if (timer !== undefined) clearTimeout(timer);
      schedule(EMPTY_POLL_MS);
    };
    schedule(EMPTY_POLL_MS);
    return () => { if (timer !== undefined) clearTimeout(timer); };
  }, []);

  useEffect(() => {
    const matches = (event: Event) => (event as CustomEvent<{sessionId: string}>).detail?.sessionId === sessionId;
    const refresh = (event: Event) => {
      if (!matches(event)) return;
      setSelected(undefined);
      void loadRef.current();
      element.current?.scrollIntoView({block: "nearest"});
    };
    const arm = (event: Event) => {
      if (!matches(event)) return;
      expectSince.current = Date.now();
      expectCount.current = itemsRef.current.length;
      kick.current();
      void loadRef.current();
    };
    window.addEventListener("idea-research-updated", refresh);
    window.addEventListener(IDEA_RESEARCH_EXPECTED_EVENT, arm);
    return () => {
      window.removeEventListener("idea-research-updated", refresh);
      window.removeEventListener(IDEA_RESEARCH_EXPECTED_EVENT, arm);
    };
  }, [sessionId]);
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
  // A spent budget is terminal: explain the used/limit tokens and never offer an
  // end action the engine would no-op, or a resume that would hit the same ceiling.
  const budget = r.status === "budget_exhausted"
    ? t("ideaResearch.budgetExhausted", {
        used: r.usageKnown ? t("ideaResearch.budgetUsed", { count: r.tokens }) : t("ideaResearch.tokensPartial", { count: r.tokens }),
        limit: r.settings.maxTokens == null ? t("ideaResearch.budgetNoLimit") : t("ideaResearch.budgetLimit", { count: r.settings.maxTokens }),
      })
    : undefined;
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
        {budget ? <p>{budget}</p> : r.reason && <p>{r.reason}</p>}
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
          {!["completed", "ended", "budget_exhausted"].includes(r.status) && <button className="secondary-button" type="button" disabled={busy} onClick={() => setConfirmEnd(r.id)}>{t("ideaResearch.end")}</button>}
        </div>
        {confirmEnd === r.id && !["completed", "ended", "budget_exhausted"].includes(r.status) && <div role="alert">{t("ideaResearch.endWarning")}<div className="idea-research-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => void command("end", r.id)}>{t("ideaResearch.endConfirm")}</button><button className="secondary-button" type="button" onClick={() => setConfirmEnd(undefined)}>{t("ideaResearch.endCancel")}</button></div></div>}
      </div>} />}
  </section>;
}
