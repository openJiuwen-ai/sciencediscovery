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
 * The way into a search: the task, the search and what it may change.
 *
 * A search is designed, not configured: the agent needs a conversation to
 * write the scoring, check that it can rank candidates, and freeze it. So this
 * dialog collects the choices a person can make before that conversation —
 * what to improve, which search suits the shape of the problem, and whether
 * the search may touch parameters — and then places the command in the
 * composer: the flags as a token, the task as the sentence after it, for the
 * user to finish or replace and send themselves. The dialog never sends, so
 * the composer keeps the last word.
 *
 * The two searches are chips; hovering or focusing one raises the illustrated
 * card that used to sit under it, with the picture above the words. The card
 * floats over the form rather than taking a row of its own: the description is
 * a reading, not a step, so it must not push the task and the settings down or
 * keep the dialog from fitting one screen.
 *
 * The form is drawn even when the runtime cannot run it: a person who has
 * already chosen a search should see the choice kept, and the reason the search
 * cannot start should be a statement beside the button rather than a different
 * dialog. The explanation of that reason — and the install that removes it —
 * lives one click away, in `EvolveRuntimeDialog`.
 */

import { useEffect, useRef, useState } from "react";

import type { EvolveStatus } from "../../api/evolve.js";
import type { EvolveAlgorithm, EvolveCheckpointMode, EvolveDirectionInput } from "@sciencediscovery/schema";
import { evolveCommand } from "../../evolve/command.js";
import { getLanguage, TEXT } from "../../text.js";
import { claimsEscape } from "../dialog-escape.js";
import { DirectionInput } from "./DirectionInput.js";
import { EvolveRuntimeDialog } from "./EvolveRuntimeDialog.js";


export interface EvolveCreateDialogProps {
  archived: boolean;
  error?: string;
  /** The search a command already chose, carried through the setup detour so
   *  a `--algorithm openevolve` draft does not come back on the dialog's own
   *  default. */
  initialAlgorithm?: EvolveAlgorithm;
  /** The pace a command already chose, carried through the setup detour so a
   *  `--no-confirm` draft does not come back switched on. */
  initialCheckpointMode?: EvolveCheckpointMode;
  /** The task already written when the dialog opened — the sentence after a
   *  typed command, or the draft the composer held when the surface was
   *  opened from 会话设置 — so it is not typed twice. */
  initialGoal?: string;
  initializing: boolean;
  onClose: () => void;
  /** Drafts starting parameters from the task typed here. Absent when there is
   *  no open session to ask; uploading a file and adding parameters by hand
   *  still work. */
  onGenerateDirection?: (task: string, signal: AbortSignal) => Promise<EvolveDirectionInput>;
  onInitialize: () => void;
  /** The command with the task after it, plus the confirmed parameters when
   *  the panel was used. It is placed in the composer, never sent here. */
  onSend: (command: string, direction?: EvolveDirectionInput) => void;
  running: boolean;
  status: EvolveStatus;
}

const VARIANTS = ["puct", "openevolve"] as const;

export function EvolveCreateDialog({
  archived,
  error,
  initialAlgorithm,
  initialCheckpointMode,
  initialGoal,
  initializing,
  onClose,
  onGenerateDirection,
  onInitialize,
  onSend,
  running,
  status,
}: EvolveCreateDialogProps) {
  const [algorithm, setAlgorithm] = useState<EvolveAlgorithm>(initialAlgorithm ?? "puct");
  // Confirm by default: pausing is the safe pace, and an unattended design
  // spends real model calls before the user has seen a single checkpoint.
  const [confirm, setConfirm] = useState(initialCheckpointMode !== "auto");
  const [goal, setGoal] = useState(initialGoal ?? "");
  const [customScope, setCustomScope] = useState(false);
  const [direction, setDirection] = useState<EvolveDirectionInput>();
  const chinese = getLanguage() === "zh-CN";
  // The consent to run without a sandbox is asked at the moment it is used,
  // not collected ahead of time: a switch that sits on the form invites the
  // reading "this is a setting", and a setting gets set once and forgotten.
  // Here the answer is per-send or it does not exist.
  const [confirming, setConfirming] = useState(false);
  /** The runtime explanation. A separate surface rather than an expanded
   *  banner: the paths are long and the form underneath must keep its place. */
  const [details, setDetails] = useState(false);
  /** Which search's description is showing. Hover and keyboard focus are kept
   *  apart: a pointer leaving must not take away a description focus opened,
   *  and a click — which focuses a chip without asking for details — must not
   *  leave one open. */
  const [hovered, setHovered] = useState<EvolveAlgorithm>();
  const [focused, setFocused] = useState<EvolveAlgorithm>();
  // Only a pointer or a keyboard asks for the card. Showing one at rest would
  // float it over the task field the form is asking for, and the chips already
  // carry the choice.
  const preview = hovered ?? focused;
  const task = useRef<HTMLTextAreaElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const fields = useRef<HTMLDivElement>(null);
  /** Whether the fields continue below the fold. The actions stay pinned, so
   *  without this the form looks complete at the cut and the parameters are
   *  never found in a short window. */
  const [overflowing, setOverflowing] = useState(false);

  // The task field is the dialog's first answer, so it takes focus, with the
  // caret after whatever was carried in: the next keystroke continues the
  // sentence instead of replacing it.
  useEffect(() => {
    const node = task.current;
    if (node === null) return;
    const end = node.value.length;
    node.setSelectionRange(end, end);
  }, []);

  useEffect(() => {
    const node = scrollArea.current;
    const content = fields.current;
    if (node === null || content === null) return;
    const update = () => {
      setOverflowing(node.scrollHeight - node.scrollTop - node.clientHeight > 2);
    };
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(node);
    observer?.observe(content);
    return () => {
      node.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onKey = (event: KeyboardEvent) => {
      if (!claimsEscape(event)) return;
      event.preventDefault();
      // The overlays are the topmost surfaces: Escape answers the one on top,
      // not the dialog underneath.
      if (confirming) {
        setConfirming(false);
        return;
      }
      if (details) {
        setDetails(false);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirming, details, onClose]);

  const unisolated = status.sandbox === "direct";
  const ready = status.state === "ready";
  const installing = initializing || status.state === "installing";

  // The explanation describes a state that no longer exists once the install
  // (or a later poll) reports ready. Leaving it open would keep describing a
  // problem that is gone and hide the form it just unblocked.
  useEffect(() => {
    if (ready) setDetails(false);
  }, [ready]);
  const blocked = archived ? TEXT.evolve.create.blockedArchived
    : running ? TEXT.evolve.create.blockedRunning
      : undefined;
  const canSend = ready && blocked === undefined
    && goal.trim() !== ""
    && (!customScope || Boolean(direction?.editable.length));
  const send = (allowDirect = false) => {
    const command = evolveCommand(algorithm, goal, confirm ? "confirm" : "auto", allowDirect);
    onSend(command, customScope ? direction : undefined);
  };

  const descriptions: Record<EvolveAlgorithm, { bullets: readonly string[]; label: string; tags: readonly string[] }> = {
    openevolve: {
      bullets: TEXT.evolve.create.openEvolvePoints,
      label: TEXT.evolve.create.openEvolveName,
      tags: TEXT.evolve.create.openEvolveTags,
    },
    puct: {
      bullets: TEXT.evolve.create.puctPoints,
      label: TEXT.evolve.create.puctName,
      tags: TEXT.evolve.create.puctTags,
    },
  };

  return <>
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        aria-labelledby="evolve-create-title"
        aria-modal="true"
        className="modal-panel evolve-create"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="modal-header">
          <h2 id="evolve-create-title">{TEXT.evolve.create.title}</h2>
          <button aria-label={TEXT.evolve.create.cancel} className="modal-close" onClick={onClose} type="button">
            ×
          </button>
        </header>

        <form
          className="evolve-create-body"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSend) return;
            // The alert owns the last word: the command leaves with the flag
            // only after the user answered it.
            if (unisolated) {
              setConfirming(true);
              return;
            }
            send(unisolated);
          }}
        >
          {/* The fields scroll; the actions do not. A short window would
              otherwise put 开始设计 at the bottom of a scroll and make the one
              thing the form is for the last thing found. */}
          <div
            className={`evolve-create-scroll${overflowing ? " is-overflowing" : ""}`}
            ref={scrollArea}
          >
            <div className="evolve-create-fields" ref={fields}>
              {/* A runtime that cannot run the search is the first thing to know,
                  and it is the only reason this banner is drawn. A ready runtime
                  gets no banner — the absence of the warning states a working
                  setup. */}
              {ready ? null : <div className="evolve-create-runtime" role="note">
                <span className="evolve-create-runtime-text">
                  <WarningGlyph />
                  <span>{installing ? TEXT.evolve.setup.bannerInstalling : TEXT.evolve.setup.bannerTitle}</span>
                </span>
                <button className="evolve-create-runtime-more" onClick={() => setDetails(true)} type="button">
                  {TEXT.evolve.setup.bannerAction}
                  <ExternalLinkGlyph />
                </button>
              </div>}

              {/* The no-isolation statement is a fact about this host, not an
                  error to fix, so it stays even when the runtime is ready. Before
                  the runtime reports ready it has not said which isolation it will
                  use, so the dialog states the risk rather than promise one. */}
              {!ready || unisolated ? <div className="evolve-create-notice" role="note">
                <span className="evolve-create-notice-icon"><InfoGlyph /></span>
                <span className="evolve-create-notice-text">
                  <strong>{TEXT.evolve.create.unisolatedBannerTitle}</strong>
                  <span>{TEXT.evolve.create.unisolatedBannerBody}</span>
                </span>
              </div> : null}

              <fieldset className="evolve-create-algorithms">
                <legend>{TEXT.evolve.create.algorithmLabel}</legend>
                <div className="evolve-algorithm-picker">
                  <div
                    aria-label={TEXT.evolve.create.algorithmLabel}
                    className="evolve-algorithm-options"
                    role="radiogroup"
                  >
                    {/* Each chip and its card share a positioning box, so the
                        card opens under the button it describes rather than
                        under the middle of the row. */}
                    {VARIANTS.map((variant) => <div
                      className="evolve-algorithm-option"
                      key={variant}
                      role="presentation"
                    >
                      <AlgorithmChip
                        checked={algorithm === variant}
                        label={descriptions[variant].label}
                        onFocusChange={(on) => setFocused((current) => (on ? variant : current === variant ? undefined : current))}
                        onHover={(on) => setHovered((current) => (on ? variant : current === variant ? undefined : current))}
                        onSelect={() => setAlgorithm(variant)}
                        variant={variant}
                      />
                      {/* The card is the illustrated one the two-search layout
                          used, raised on hover or focus: the picture first,
                          then the name, tags and points in their old type. It
                          floats clear of the flow, so reading a description
                          never moves the task under it. Closed cards stay in
                          the DOM so `aria-describedby` always resolves. */}
                      <div
                        className={`evolve-algorithm-detail${preview === variant ? " is-open" : ""}`}
                        id={`evolve-algorithm-detail-${variant}`}
                      >
                        {/* Decoration: the card's name, tags and points already
                            say which search this is, so the illustration
                            carries no alternative text. */}
                        <span aria-hidden="true" className={`evolve-algorithm-art is-${variant}`} />
                        <span className="evolve-algorithm-body">
                          <span className="evolve-algorithm-name">{descriptions[variant].label}</span>
                          <span className="evolve-algorithm-tags">
                            {descriptions[variant].tags.map((tag) =>
                              <span className="evolve-algorithm-tag" key={tag}>{tag}</span>)}
                          </span>
                          <span className="evolve-algorithm-points">
                            {descriptions[variant].bullets.map((bullet) => <span key={bullet}>{bullet}</span>)}
                          </span>
                        </span>
                      </div>
                    </div>)}
                  </div>
                </div>
              </fieldset>

              {/* The task is what the design conversation starts from. It also
                  travels to the composer, where it stays editable until the user
                  sends: the dialog collects, it does not commit. */}
              <label className="evolve-create-task">
                <span>{TEXT.evolve.create.taskLabel}</span>
                <textarea
                  autoFocus
                  className="evolve-create-task-input"
                  onChange={(event) => setGoal(event.target.value)}
                  placeholder={TEXT.evolve.create.taskPlaceholder}
                  ref={task}
                  required
                  rows={3}
                  value={goal}
                />
              </label>

              <div className="evolve-create-settings">
                <h3>{TEXT.evolve.create.settingsLabel}</h3>
                <div className="evolve-create-setting">
                  <label className="evolve-create-confirm">
                    <input
                      checked={confirm}
                      onChange={(event) => setConfirm(event.target.checked)}
                      role="switch"
                      type="checkbox"
                    />
                    <span>{TEXT.evolve.create.confirmLabel}</span>
                  </label>
                  <p className="evolve-create-confirm-hint">
                    {confirm ? TEXT.evolve.create.confirmHint : TEXT.evolve.create.autoHint}
                  </p>
                </div>
                <div className="evolve-create-setting">
                  <label className="evolve-create-confirm">
                    <input
                      checked={customScope}
                      onChange={(event) => setCustomScope(event.target.checked)}
                      role="switch"
                      type="checkbox"
                    />
                    <span>{TEXT.evolve.create.parametersLabel}</span>
                  </label>
                  <p className="evolve-create-confirm-hint">{TEXT.evolve.create.parametersHint}</p>
                </div>
              </div>

              {/* Kept mounted while closed so the fields the user entered are still
                  there when the switch goes back on. */}
              <div
                className="evolve-create-direction"
                hidden={!customScope}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
                }}
              >
                <DirectionInput
                  chinese={chinese}
                  onChange={setDirection}
                  onGenerate={onGenerateDirection === undefined || goal.trim() === ""
                    ? undefined
                    : (signal) => onGenerateDirection(goal.trim(), signal)}
                />
              </div>

              {blocked === undefined ? null : <p className="evolve-create-blocked">{blocked}</p>}
            </div>
          </div>

          <footer className="modal-footer">
            <button className="evolve-create-cancel" onClick={onClose} type="button">
              {TEXT.evolve.create.cancel}
            </button>
            {/* Greyed, not hidden, while the runtime is unavailable or the task
                is empty: the choice the user made stays visible, and the reason
                sits right above the button that cannot send it. */}
            <button className="evolve-create-submit" disabled={!canSend} type="submit">
              {TEXT.evolve.create.send}
            </button>
          </footer>
        </form>
      </div>
    </div>

    {details ? <EvolveRuntimeDialog
      error={error}
      initializing={initializing}
      onClose={() => setDetails(false)}
      onInitialize={onInitialize}
      status={status}
    /> : null}

  {/* The last gate before the command is sent. Its answer travels with the
      command as `--allow-direct`; closing it any way other than the continue
      button leaves the answer as "no". */}
  {confirming ? <div className="modal-backdrop evolve-confirm-backdrop" onPointerDown={() => setConfirming(false)}>
    <div
      aria-describedby="evolve-unisolated-body"
      aria-labelledby="evolve-unisolated-title"
      aria-modal="true"
      className="modal-panel evolve-unisolated-confirm"
      onPointerDown={(event) => event.stopPropagation()}
      role="alertdialog"
    >
      <header className="modal-header">
        <h2 id="evolve-unisolated-title">{TEXT.evolve.create.unisolatedConfirmTitle}</h2>
        {/* Closing any way but the continue button is "no": the ×, Escape and
            the backdrop all leave the command without `--allow-direct`. */}
        <button
          aria-label={TEXT.evolve.create.unisolatedConfirmClose}
          className="modal-close"
          onClick={() => setConfirming(false)}
          type="button"
        >
          ×
        </button>
      </header>
      <div className="evolve-unisolated-body" id="evolve-unisolated-body">
        <p>{TEXT.evolve.create.unisolatedConfirmBody}</p>
      </div>
      <footer className="modal-footer">
        {/* Focus lands on the answer that keeps things as they are: the
            risky action is never the one an Enter keypress finds. */}
        <button autoFocus className="secondary-button" onClick={() => setConfirming(false)} type="button">
          {TEXT.evolve.create.unisolatedConfirmCancel}
        </button>
        <button
          className="evolve-confirm-continue"
          onClick={() => {
            setConfirming(false);
            send(true);
          }}
          type="button"
        >
          {TEXT.evolve.create.unisolatedConfirmContinue}
        </button>
      </footer>
    </div>
  </div> : null}
  </>;
}

/** One search as a chip. Its card floats under the row on hover or keyboard
 *  focus; `aria-describedby` gives a screen reader the same text without
 *  either. */
function AlgorithmChip({ checked, label, onFocusChange, onHover, onSelect, variant }: {
  checked: boolean;
  label: string;
  onFocusChange: (on: boolean) => void;
  onHover: (on: boolean) => void;
  onSelect: () => void;
  variant: EvolveAlgorithm;
}) {
  return <button
    aria-checked={checked}
    aria-describedby={`evolve-algorithm-detail-${variant}`}
    className={`evolve-algorithm-chip${checked ? " is-checked" : ""}`}
    onBlur={() => onFocusChange(false)}
    onClick={onSelect}
    onFocus={(event) => {
      // A click focuses the chip too, but it means "choose this", not "tell me
      // more": only keyboard focus opens the description.
      if (typeof event.currentTarget.matches !== "function"
          || event.currentTarget.matches(":focus-visible")) onFocusChange(true);
    }}
    onPointerEnter={() => onHover(true)}
    onPointerLeave={() => onHover(false)}
    role="radio"
    type="button"
  >
    {/* Decoration: the chip's name already says which search this is. */}
    <span aria-hidden="true" className="evolve-algorithm-mark" />
    <span className="evolve-algorithm-name">{label}</span>
  </button>;
}

function WarningGlyph() {
  return <svg aria-hidden="true" className="evolve-create-runtime-icon" height="16" viewBox="0 0 24 24" width="16">
    <path d="M10.7 3.9a1.5 1.5 0 0 1 2.6 0l8.4 14.6a1.5 1.5 0 0 1-1.3 2.2H3.6a1.5 1.5 0 0 1-1.3-2.2L10.7 3.9Z" fill="#ffa940" />
    <path d="M12 8.6v5.1" stroke="#fff" strokeLinecap="round" strokeWidth="2" />
    <circle cx="12" cy="16.9" fill="#fff" r="1.15" />
  </svg>;
}

function InfoGlyph() {
  return <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
    <circle cx="8" cy="8" fill="#1476ff" r="7.2" />
    <path d="M8 7.1v4.3" stroke="#fff" strokeLinecap="round" strokeWidth="1.7" />
    <circle cx="8" cy="4.7" fill="#fff" r="1" />
  </svg>;
}

function ExternalLinkGlyph() {
  return <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 14 14" width="14">
    <path
      d="M8.6 1.9H12v3.4M12 1.9 6.9 7"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.3"
    />
    <path
      d="M11 8.4V11a1.6 1.6 0 0 1-1.6 1.6H3.1A1.6 1.6 0 0 1 1.5 11V4.7a1.6 1.6 0 0 1 1.6-1.6h2.6"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.3"
    />
  </svg>;
}
