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

import { useEffect, useState } from "react";

import { CloseIcon } from "./icons.js";
import type { Translate } from "./MemoryGraphLegend.js";

/**
 * First-open tour overlay (doc16 §1.5). Two steps; Step 1 forks by entry path:
 *  - ``card``: opened from the right-rail card (no autoChain) → the canvas
 *    lands on the research spine; step 1 explains that + double-click to
 *    unfold a task's folded children.
 *  - ``chain``: opened from the product/evidence modal (autoChain lands on a
 *    focus+fog view — the entry node highlighted, rest dimmed; the chain is
 *    NOT auto-fetched anymore) → step 1 explains focus+fog browsing + the
 *    per-node "View…" buttons for tracing a specific chain.
 * Step 2 is shared: the filter-chip rows are type filters (nodes/edges).
 *
 * Visibility is controlled by the parent (``open``); ANY close path (Skip /
 * finish / Esc / click the scrim) calls ``onClose``, and the parent writes
 * ``localStorage memoryGraphTourSeen=1`` there so it never re-pops. This keeps
 * the storage write in one place (the explorer) rather than scattered.
 *
 * The scrim covers the graph canvas only (positioned inside
 * ``.memory-explorer-right``), reusing the scope-toast scrim/card visual —
 * NOT the whole explorer panel, so the header/filters/left panel stay usable.
 * Esc binds a LOCAL keydown only while open, removed on close: it must NOT
 * collide with the explorer's global ``Escape → onClose`` (which closes the
 * whole explorer). Tour Esc stops propagation so the explorer's handler never
 * sees the key while the tour is up.
 *
 * The tour does not gate on "from where you entered" beyond the step-1 fork —
 * it pops for all three entries on first open, because the interaction blind
 * spots (folded produces, chain-highlight-not-replace, filter rows) are the
 * same regardless of entry. The parent already handles the autoChain timing
 * (waits for the chain to settle before opening) so step-1 copy matches what
 * is on screen.
 */
export function MemoryGraphTour({
  open,
  onClose,
  entry,
  nodeName,
  t,
}: {
  open: boolean;
  onClose: () => void;
  /** Entry path: "card" (right-rail) vs "chain" (product/evidence modal). */
  entry: "card" | "chain";
  /** Node display name for the chain-entry step-1 title/body ({name}). */
  nodeName?: string;
  t: Translate;
}) {
  const [step, setStep] = useState(0);

  // Reset to step 0 each time the tour opens (a returning user who cleared
  // localStorage should start fresh, not at whatever step they last left).
  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  // Local Esc closes the tour (not the whole explorer). stopPropagation so the
  // explorer's global Escape→onClose never fires while the tour is up. Bound
  // only while open so it does not capture Esc when the tour is gone.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true); // capture phase, before explorer
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const total = 2;
  // Title is the same on every step ("科学记忆操作指引" / "Science memory
  // guide"); only the body copy forks by entry path.
  const titleKey = "tour.title";
  const bodyKey = step === 0
    ? (entry === "card" ? "tour.step1.card.body" : "tour.step1.chain.body")
    : "tour.step2.body";
  const isLast = step === total - 1;
  const nodeNameSafe = nodeName ?? "";

  return (
    <>
      {/* Scrim over the canvas area only; clicking it dismisses the tour. */}
      <div
        className="memory-tour-scrim"
        onMouseDown={(event) => { event.stopPropagation(); onClose(); }}
      />
      {/* Centre card. stopPropagation so clicks inside don't reach the scrim. */}
      <div
        className="memory-tour-card"
        role="dialog"
        aria-modal="false"
        aria-label={t(titleKey, { name: nodeNameSafe })}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          aria-label={t("tour.skip")}
          className="memory-tour-skip"
          onClick={onClose}
          title={t("tour.skip")}
          type="button"
        ><CloseIcon size={16} /></button>

        <h3 className="memory-tour-title">{t(titleKey, { name: nodeNameSafe })}</h3>
        <p className="memory-tour-body">{t(bodyKey, { name: nodeNameSafe })}</p>

        <div className="memory-tour-progress" aria-label={t("tour.progress", { n: step + 1, total })}>
          {Array.from({ length: total }, (_, i) => (
            <span
              aria-hidden="true"
              className={i === step ? "memory-tour-dot memory-tour-dot-active" : "memory-tour-dot"}
              key={i}
            />
          ))}
        </div>

        <div className="memory-tour-actions">
          {step > 0 ? (
            <button
              className="memory-tour-btn memory-tour-back"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              type="button"
            >{t("tour.back")}</button>
          ) : null}
          {isLast ? (
            <button
              className="memory-tour-btn memory-tour-primary"
              onClick={onClose}
              type="button"
            >{t("tour.done")}</button>
          ) : (
            <button
              className="memory-tour-btn memory-tour-primary"
              onClick={() => setStep((s) => Math.min(total - 1, s + 1))}
              type="button"
            >{t("tour.next")}</button>
          )}
        </div>
      </div>
    </>
  );
}
