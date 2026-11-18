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
 * Live updates come from the research's SSE stream, whose every frame is a whole view;
 * the stream closes once the research stops, and a reconnect refetches rather than
 * replaying. Nothing here starts a research: reopening a session must show the persisted
 * state without beginning anything, which is why the only actions are the ones the
 * research's own status allows.
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

export function IdeaResearchPanel({ client, sessionId, researchId, onClose }: {
  client: ApiClient;
  sessionId: string;
  researchId: string;
  onClose?: () => void;
}) {
  const [view, setView] = useState<IdeaResearchView>();
  const [error, setError] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<IdeaTreeNode>();
  const live = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setView(await getIdeaResearch(client, sessionId, researchId));
      setError(undefined);
    } catch (reason: unknown) {
      if (isUnavailable(reason)) setUnavailable(true);
      else setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [client, researchId, sessionId]);

  useEffect(() => { void load(); }, [load]);

  // Follow the research only while the engine says it is live; the stream closes itself
  // once it is not, and an aborted stream must not overwrite a newer view.
  const status = view?.research.status;
  useEffect(() => {
    if (!status || !["running", "pausing"].includes(status)) return;
    live.current?.abort();
    const controller = new AbortController();
    live.current = controller;
    void subscribeIdeaResearchEvents(client, sessionId, researchId, (next) => setView(next), controller.signal)
      .catch((reason: unknown) => { if (!controller.signal.aborted && !isUnavailable(reason)) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [client, researchId, sessionId, status]);

  const control = async (operation: "pause" | "continue" | "end") => {
    setBusy(true);
    setError(undefined);
    try {
      setView(await controlIdeaResearch(client, sessionId, researchId, operation));
    } catch (reason: unknown) {
      if (isUnavailable(reason)) setUnavailable(true);
      else setError(reason instanceof Error ? reason.message : String(reason));
      // The engine refused; re-read rather than leave the optimistic state behind.
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (unavailable) return <p className="idea-panel-unavailable" role="alert">{t.unavailable}</p>;
  if (!view) return <p className="idea-panel-loading">{error ?? TEXT.settings.loading}</p>;
  const research = view.research;
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
      {research.reason ? <p className="idea-panel-reason">{t.reason(research.reason)}</p> : null}
      {error ? <p className="idea-panel-error" role="alert">{error}</p> : null}
      <div className="idea-panel-body">
        <IdeaTreeView graph={view.graph} onSelect={setSelected} selectedId={selected?.id} />
        {selected ? <IdeaNodeDetail node={selected} /> : null}
      </div>
      <footer className="idea-panel-actions">
        {research.status === "running" ? <button className="secondary-button" disabled={busy} onClick={() => void control("pause")} type="button">{t.pause}</button> : null}
        {research.status === "paused" || research.status === "interrupted" ? <button className="secondary-button" disabled={busy} onClick={() => void control("continue")} type="button">{t.resume}</button> : null}
        {["running", "pausing", "paused", "interrupted"].includes(research.status)
          ? <button className="secondary-button" disabled={busy} onClick={() => void control("end")} type="button">{t.end}</button>
          : null}
      </footer>
    </section>
  );
}
