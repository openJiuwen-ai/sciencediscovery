// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * The Idea Tree task panel: progress, the tree, one node's detail, and the controls.
 *
 * Live updates come from the research's SSE stream, whose deltas are folded into the
 * view the client holds; the stream closes once the research stops, so a reconnect
 * refetches rather than replaying. A stream that fails is not the end of the panel: it
 * refetches and reconnects with a backoff, because the only other thing an error leaves
 * behind is a stale frame. Nothing here starts a research: reopening a session must show the
 * persisted state without beginning anything, which is why the only actions are the
 * ones the research's own status allows.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { IdeaResearchView, IdeaTreeNode } from "@sciencediscovery/schema";
import type { ApiClient } from "../../api/client.js";
import { ApiRequestError } from "../../api/client.js";
import { controlIdeaResearch, getIdeaResearch, subscribeIdeaResearchEvents } from "../../api/idea-tree.js";
import { TEXT } from "../../text.js";
import { IdeaNodeDetail, IdeaTreeView } from "./IdeaTree.js";

const t = TEXT.ideaTree;

/** A 503 means the Evolve sidecar is not up; that is a prerequisite, not an empty tree. */
function isUnavailable(reason: unknown): boolean {
  return reason instanceof ApiRequestError && reason.status === 503;
}

/** How many consecutive reconnect attempts a dropped stream gets before the panel
 *  stops retrying by itself and leaves the error on screen with 重试. */
const MAX_RECONNECTS = 4;

const LIVE = ["running", "pausing"];

export function IdeaResearchPanel({ client, sessionId, researchId, onClose, onResearchChanged }: {
  client: ApiClient;
  sessionId: string;
  researchId: string;
  onClose?: () => void;
  /** Reported with the view whenever the panel learns a newer one from its own
   *  writes or reads, together with the session it was opened in. The card at the
   *  transcript's foot shows the same research from the session list, and a resume
   *  creates nothing that would make the shell read that list again, so the panel
   *  is the only place that knows. The session id travels with it because the
   *  panel can be closed while a request is still in flight: an answer for the
   *  session that is gone must not be written into the one on screen, and an
   *  answer for the session still shown is wanted even after the panel is gone. */
  onResearchChanged?: (view: IdeaResearchView, sessionId: string) => void;
}) {
  const [view, setView] = useState<IdeaResearchView>();
  const [error, setError] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 结束 is irreversible, so it asks first; the tree the research already grew
   *  stays, but the research cannot be resumed. */
  const [confirmEnd, setConfirmEnd] = useState(false);
  /** Bumped when the reader asks for another attempt after the reconnects ran out;
   *  it re-runs the stream effect. */
  const [resubscribe, setResubscribe] = useState(0);
  /** The selected node by id, not by value: a stream frame replaces the nodes it
   *  carries, so holding the old object would show a node that no longer matches the
   *  tree. */
  const [selectedId, setSelectedId] = useState<string>();
  const live = useRef<AbortController | undefined>(undefined);
  /** Held in a ref so reporting a view cannot change the identity of the reads
   *  and effects below: a caller that passes an inline lambda must not make the
   *  panel refetch. */
  const changed = useRef(onResearchChanged);
  useEffect(() => { changed.current = onResearchChanged; }, [onResearchChanged]);
  /** A read or a control can answer after the panel is gone — the reader closed
   *  it, opened another research, or switched sessions — so its own state is only
   *  written while it is mounted. Reporting is different: the answer is still the
   *  truth for the session it was asked in, and that session, not the panel, is
   *  what decides whether it still applies. */
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  /** `keepError` is a control refusal that outlives the reload: the read refreshes the
   *  tree, but its own success or failure must not erase why the control was refused. */
  const load = useCallback(async (keepError?: string) => {
    try {
      const next = await getIdeaResearch(client, sessionId, researchId);
      changed.current?.(next, sessionId);
      if (!mounted.current) return;
      setView(next);
      // A later read that works is what makes the prerequisite notice go away:
      // the service came back, and the panel should not keep saying it is down.
      setUnavailable(false);
      setError(keepError);
    } catch (reason: unknown) {
      if (isUnavailable(reason)) {
        setUnavailable(true);
        if (keepError !== undefined) setError(keepError);
      } else {
        setError(keepError ?? (reason instanceof Error ? reason.message : String(reason)));
      }
    }
  }, [client, researchId, sessionId]);

  useEffect(() => { void load(); }, [load]);

  // Follow the research only while the engine says it is live. A dropped stream
  // refetches and reconnects with a backoff: the subscription merges deltas into a
  // tree it builds itself, so the refetch is not a replay but the current state.
  const status = view?.research.status;
  useEffect(() => {
    if (!status || !LIVE.includes(status)) return undefined;
    live.current?.abort();
    const controller = new AbortController();
    live.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const follow = async () => {
      try {
        await subscribeIdeaResearchEvents(client, sessionId, researchId, (next) => setView(next), controller.signal);
      } catch (reason: unknown) {
        if (controller.signal.aborted) return;
        if (isUnavailable(reason)) {
          setUnavailable(true);
          return;
        }
        setError(reason instanceof Error ? reason.message : String(reason));
        attempt += 1;
        if (attempt > MAX_RECONNECTS) return;
        timer = globalThis.setTimeout(() => {
          if (controller.signal.aborted) return;
          void load().finally(() => { if (!controller.signal.aborted) void follow(); });
        }, Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
      }
    };
    void follow();
    return () => {
      controller.abort();
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [client, researchId, sessionId, status, load, resubscribe]);

  const control = async (operation: "pause" | "continue" | "end") => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await controlIdeaResearch(client, sessionId, researchId, operation);
      // The answer is the service's own state after the control, so it is also the
      // truth for every other place that shows this research — the session list
      // included. It is reported even if the reader closed the panel meanwhile:
      // pressing 继续 and then closing is the shortest path to the reported bug,
      // and the list is the thing that has to learn. Whether it still applies is
      // decided by the session it names, not by this component's life.
      changed.current?.(next, sessionId);
      if (!mounted.current) return;
      setView(next);
      setUnavailable(false);
    } catch (reason: unknown) {
      if (isUnavailable(reason)) {
        setUnavailable(true);
        await load();
      } else {
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        // The engine refused; re-read rather than leave the optimistic state behind,
        // but keep the refusal on the error bar: the reload is not its resolution.
        await load(message);
      }
    } finally {
      setBusy(false);
      setConfirmEnd(false);
    }
  };

  if (unavailable) {
    return (
      <div className="idea-panel">
        <p className="idea-panel-unavailable" role="alert">{t.unavailable}</p>
        <div className="idea-panel-actions">
          <button className="secondary-button" onClick={() => void load()} type="button">{t.retry}</button>
        </div>
      </div>
    );
  }
  if (!view) return <p className="idea-panel-loading">{error ?? TEXT.settings.loading}</p>;
  const research = view.research;
  // Re-read the node from the view that is on screen: a frame may have replaced it.
  const selectedNode = selectedId === undefined ? undefined : view.graph.nodes.find((node) => node.id === selectedId);
  const canResume = research.status === "paused" || research.status === "interrupted";
  // A spent budget is terminal: there is no 继续, and the engine's English reason is
  // replaced by a Chinese note that names the used and limit token counts.
  const budgetExhausted = research.status === "budget_exhausted";
  return (
    <section className="idea-panel" aria-label={t.heading}>
      <header className="idea-panel-header">
        <div>
          <span className="eyebrow">{t.heading}</span>
          <h2>{research.objective}</h2>
        </div>
        {onClose ? <button className="icon-button" aria-label={TEXT.settings.close} onClick={onClose} type="button">×</button> : null}
      </header>
      <div className="idea-panel-progress">
        <span>{t.status[research.status] ?? research.status}</span>
        <span>{(t.phase as Record<string, string | undefined>)[research.phase] ?? research.phase}</span>
        <span>{t.round(research.round)}</span>
        {research.batch.length ? <span>{t.batch(research.batchCompleted, research.batch.length)}</span> : null}
        <span>{research.usageKnown ? t.tokens(research.tokens) : t.tokensUnknown}</span>
      </div>
      {budgetExhausted
        ? <p className="idea-panel-reason">{t.budgetExhausted(research.usageKnown ? research.tokens : null, research.settings.maxTokens ?? null)}</p>
        : research.reason ? <p className="idea-panel-reason">{t.reason(research.reason)}</p> : null}
      {error ? (
        <div className="idea-panel-error" role="alert">
          <span>{error}</span>
          <button
            className="secondary-button"
            onClick={() => { setError(undefined); setResubscribe((count) => count + 1); void load(); }}
            type="button"
          >{t.retry}</button>
        </div>
      ) : null}
      <div className="idea-panel-body">
        <IdeaTreeView graph={view.graph} onSelect={(node) => setSelectedId(node.id)} selectedId={selectedId} />
        {selectedNode ? <IdeaNodeDetail node={selectedNode} /> : null}
      </div>
      <footer className="idea-panel-actions">
        {research.status === "running" ? <button className="secondary-button" disabled={busy} onClick={() => void control("pause")} type="button">{t.pause}</button> : null}
        {canResume ? <button className="secondary-button" disabled={busy} onClick={() => void control("continue")} type="button">{t.resume}</button> : null}
        {LIVE.includes(research.status) || canResume || research.status === "paused"
          ? (confirmEnd
            ? <>
              <span className="idea-panel-confirm">{t.endConfirm}</span>
              <button className="secondary-button" disabled={busy} onClick={() => setConfirmEnd(false)} type="button">{TEXT.menu.cancel}</button>
              <button className="primary-button" disabled={busy} onClick={() => void control("end")} type="button">{t.end}</button>
            </>
            : <button className="secondary-button" disabled={busy} onClick={() => setConfirmEnd(true)} type="button">{t.end}</button>)
          : null}
      </footer>
    </section>
  );
}
