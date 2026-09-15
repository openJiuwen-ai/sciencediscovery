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

// Evidence chip hover preview (V3-C3), ported from the Science Agent
// EvidenceLinkHover/AnchorPreviewCard kernel. SA needed event delegation
// (its citation links were dangerouslySetInnerHTML); SD renders chips through
// the react-markdown component tree, so a plain React wrapper suffices — the
// interaction parameters are what carry over: 200ms hover-intent open, 150ms
// hide grace (pointer travel chip→card keeps it alive), above/below placement
// (340px threshold), viewport clamping, portal to body, Escape/scroll close.
//
// Data: the same single chain request the EvidenceModal makes
// (getMemoryChain … viewSourcePaper → evidence + upstream Paper in one shot),
// cached per (sessionId, evidenceId) so re-hovering is free. Failures degrade
// to an "unavailable" card that still offers the detail modal — the click path
// is unchanged either way.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { MemoryGraphChainResult } from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { firstContentValue } from "./NodeField.js";
import { useLocale } from "./i18n/index.js";

const OPEN_DELAY_MS = 200;
const HIDE_DELAY_MS = 150;
const ABOVE_THRESHOLD_PX = 340;
const CARD_WIDTH = 320;
const VIEWPORT_MARGIN = 8;
const CACHE_CAP = 100;

interface PreviewData {
  content?: string;
  paperTitle?: string;
}

type PreviewState =
  | { kind: "loading" }
  | { kind: "loaded"; data: PreviewData }
  | { kind: "error" };

// Module-level promise cache: dedupes concurrent hovers of the same chip and
// makes re-hover instant. FIFO-trimmed; entries are read-only graph reads.
const previewCache = new Map<string, Promise<PreviewData>>();

function loadPreview(client: ApiClient, evidenceId: string, sessionId: string): Promise<PreviewData> {
  const key = `${sessionId}:${evidenceId}`;
  const cached = previewCache.get(key);
  if (cached) return cached;
  const promise = client
    .getMemoryChain(evidenceId, sessionId, undefined, "viewSourcePaper")
    .then((chain) => {
      const result = chain as MemoryGraphChainResult;
      const nodes = result?.nodes ?? [];
      const evidence = nodes.find((node) => node.id === evidenceId);
      const paper = nodes.find((node) => node.label === "Paper");
      const paperExtra = (paper?.extra as Record<string, unknown> | undefined) ?? {};
      return {
        content: firstContentValue(evidence?.extra),
        paperTitle: typeof paperExtra.title === "string" ? paperExtra.title : undefined,
      } satisfies PreviewData;
    });
  previewCache.set(key, promise);
  if (previewCache.size > CACHE_CAP) {
    previewCache.delete(previewCache.keys().next().value!);
  }
  // A rejected promise must not poison the cache forever — drop it so the
  // next hover retries (memory-graph may have recovered). Identity check: a
  // newer request for the same key (post-FIFO-eviction) must not be deleted
  // by the old promise's late rejection.
  promise.catch(() => {
    if (previewCache.get(key) === promise) previewCache.delete(key);
  });
  return promise;
}

export interface EvidenceHoverProps {
  children: ReactNode;
  client: ApiClient;
  evidenceId: string;
  /** Opens the full EvidenceModal (the chip's original click path). */
  onOpenDetails: (evidenceId: string) => void;
  sessionId: string;
}

export function EvidenceHover({ children, client, evidenceId, onOpenDetails, sessionId }: EvidenceHoverProps) {
  const { t } = useLocale();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [card, setCard] = useState<{ left: number; top: number; placement: "above" | "below" } | null>(null);
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  const cleanupRef = useRef<(() => void) | undefined>(undefined);

  function clearTimers() {
    clearTimeout(openTimer.current);
    clearTimeout(hideTimer.current);
  }

  function close() {
    clearTimers();
    setCard(null);
  }

  function open() {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const placement = rect.top > ABOVE_THRESHOLD_PX ? "above" : "below";
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN),
    );
    setCard({ left, placement, top: placement === "above" ? rect.top : rect.bottom });
    let active = true;
    setState({ kind: "loading" });
    void loadPreview(client, evidenceId, sessionId)
      .then((data) => { if (active) setState({ kind: "loaded", data }); })
      .catch(() => { if (active) setState({ kind: "error" }); });
    // The card outlives this render pass via portal; guard the setState with
    // the close-path cleanup below (timers + listeners own `active`).
    cleanupRef.current = () => { active = false; };
  }

  function scheduleOpen() {
    // Already open (pointer left the card area but came back inside the hide
    // grace): just stay alive — reopening would flash the loading state and
    // orphan the previous fetch's active-guard.
    if (card) {
      cancelHide();
      return;
    }
    clearTimers();
    openTimer.current = setTimeout(open, OPEN_DELAY_MS);
  }

  function scheduleHide() {
    clearTimers();
    hideTimer.current = setTimeout(close, HIDE_DELAY_MS);
  }

  function cancelHide() {
    clearTimeout(hideTimer.current);
  }

  // Escape / scroll close, and the async-guard cleanup, live only while open.
  useEffect(() => {
    if (!card) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, { capture: true, once: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, { capture: true });
      cleanupRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card !== null]);

  // Unmount safety: no dangling timers, no setState after unmount.
  useEffect(() => () => { clearTimers(); cleanupRef.current?.(); }, []);

  return (
    <span
      className="evidence-hover-anchor"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleHide}
      ref={anchorRef}
    >
      {children}
      {card
        ? createPortal(
            <div
              className={`evidence-hover-card ${card.placement}`}
              onMouseEnter={cancelHide}
              onMouseLeave={scheduleHide}
              role="tooltip"
              style={{
                left: card.left,
                width: CARD_WIDTH,
                ...(card.placement === "above" ? { bottom: window.innerHeight - card.top + 6 } : { top: card.top + 6 }),
              }}
            >
              <div className="evidence-hover-card-header">
                <span className="eyebrow">{t("research.hover.evidencePreview")}</span>
              </div>
              <div className="evidence-hover-card-body">
                {state.kind === "loading" ? <p className="evidence-hover-loading">{t("research.hover.loading")}</p> : null}
                {state.kind === "error" ? <p className="evidence-hover-unavailable">{t("research.hover.unavailable")}</p> : null}
                {state.kind === "loaded" ? (
                  <>
                    {state.data.paperTitle ? <p className="evidence-hover-source">{state.data.paperTitle}</p> : null}
                    <p className="evidence-hover-snippet">{state.data.content ?? t("research.hover.noContent")}</p>
                  </>
                ) : null}
              </div>
              <div className="evidence-hover-card-footer">
                <button
                  className="evidence-hover-open"
                  onClick={() => { close(); onOpenDetails(evidenceId); }}
                  type="button"
                >{t("research.hover.openDetails")}</button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
