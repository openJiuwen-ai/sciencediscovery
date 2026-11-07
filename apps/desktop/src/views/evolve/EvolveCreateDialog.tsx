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
 * The way into a search that is not a form.
 *
 * A search is designed, not configured: the agent needs a conversation to
 * write the scoring, check that it can rank candidates, and freeze it. So this
 * dialog collects the one choice a person can make before that conversation —
 * which search suits the shape of the problem — and then places the command in
 * the composer: the flags as a token, for the user to finish with a sentence
 * of their own and send.
 *
 * The form is drawn even when the runtime cannot run it: a person who has
 * already chosen a search should see the choice kept, and the reason the search
 * cannot start should be a statement beside the button rather than a different
 * dialog. The explanation of that reason — and the install that removes it —
 * lives one click away, in `EvolveRuntimeDialog`.
 */

import { useEffect, useState } from "react";

import type { EvolveStatus } from "../../api/evolve.js";
import type { EvolveAlgorithm, EvolveCheckpointMode } from "@sciencediscovery/schema";
import { evolveCommand } from "../../evolve/command.js";
import { TEXT } from "../../text.js";
import { claimsEscape } from "../dialog-escape.js";
import { EvolveRuntimeDialog } from "./EvolveRuntimeDialog.js";


export interface EvolveCreateDialogProps {
  archived: boolean;
  error?: string;
  /** The search the typed command already chose, carried through the setup
   *  detour so a `--algorithm openevolve` draft does not come back on the
   *  dialog's own default. */
  initialAlgorithm?: EvolveAlgorithm;
  /** The pace the typed command already chose, carried through the setup
   *  detour so a `--no-confirm` draft does not come back switched on. */
  initialCheckpointMode?: EvolveCheckpointMode;
  /** A sentence the user already typed after the command, carried through the
   *  setup detour so it is not lost: it goes back into the composer after the
   *  token when the dialog closes. */
  initialGoal?: string;
  initializing: boolean;
  onClose: () => void;
  onInitialize: () => void;
  onSend: (command: string) => void;
  running: boolean;
  status: EvolveStatus;
}

export function EvolveCreateDialog({
  archived,
  error,
  initialAlgorithm,
  initialCheckpointMode,
  initialGoal,
  initializing,
  onClose,
  onInitialize,
  onSend,
  running,
  status,
}: EvolveCreateDialogProps) {
  const [algorithm, setAlgorithm] = useState<EvolveAlgorithm>(initialAlgorithm ?? "puct");
  // Confirm by default: pausing is the safe pace, and an unattended design
  // spends real model calls before the user has seen a single checkpoint.
  const [confirm, setConfirm] = useState(initialCheckpointMode !== "auto");
  // The consent to run without a sandbox is asked at the moment it is used,
  // not collected ahead of time: a switch that sits on the form invites the
  // reading "this is a setting", and a setting gets set once and forgotten.
  // Here the answer is per-send or it does not exist.
  const [confirming, setConfirming] = useState(false);
  /** The runtime explanation. A separate surface rather than an expanded
   *  banner: the paths are long and the form underneath must keep its place. */
  const [details, setDetails] = useState(false);

  useEffect(() => {
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
  const canSend = ready && blocked === undefined;
  // The goal now lives in the composer, after the token. A sentence that came
  // through the detour goes back with the command so it is not typed twice.
  const goal = initialGoal ?? "";
  const command = evolveCommand(algorithm, goal, confirm ? "confirm" : "auto");

  return <>
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        aria-labelledby="evolve-create-title"
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
            onSend(command);
          }}
        >
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
            <div aria-label={TEXT.evolve.create.algorithmLabel} role="radiogroup">
              <AlgorithmChoice
                bullets={TEXT.evolve.create.puctPoints}
                checked={algorithm === "puct"}
                label={TEXT.evolve.create.puctName}
                onSelect={() => setAlgorithm("puct")}
                tags={TEXT.evolve.create.puctTags}
                variant="puct"
              />
              <AlgorithmChoice
                bullets={TEXT.evolve.create.openEvolvePoints}
                checked={algorithm === "openevolve"}
                label={TEXT.evolve.create.openEvolveName}
                onSelect={() => setAlgorithm("openevolve")}
                tags={TEXT.evolve.create.openEvolveTags}
                variant="openevolve"
              />
            </div>
          </fieldset>

          <div className="evolve-create-settings">
            <h3>{TEXT.evolve.create.settingsLabel}</h3>
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

          {blocked === undefined ? null : <p className="evolve-create-blocked">{blocked}</p>}

          <footer className="modal-footer">
            <button className="evolve-create-cancel" onClick={onClose} type="button">
              {TEXT.evolve.create.cancel}
            </button>
            {/* Greyed, not hidden, while the runtime is unavailable: the choice
                the user made stays visible, and the reason sits right above the
                button that cannot send it. */}
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
            onSend(evolveCommand(algorithm, goal, confirm ? "confirm" : "auto", true));
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

function AlgorithmChoice({ bullets, checked, label, onSelect, tags, variant }: {
  bullets: readonly string[];
  checked: boolean;
  label: string;
  onSelect: () => void;
  tags: readonly string[];
  variant: "puct" | "openevolve";
}) {
  return <button
    aria-checked={checked}
    className={`evolve-algorithm-choice${checked ? " is-checked" : ""}`}
    onClick={onSelect}
    role="radio"
    type="button"
  >
    {/* Decoration: the card's name, tags and points already say which search
        this is, so the illustration is drawn by the stylesheet and carries no
        alternative text. */}
    <span aria-hidden="true" className={`evolve-algorithm-art is-${variant}`} />
    <span className="evolve-algorithm-body">
      <span className="evolve-algorithm-name">{label}</span>
      <span className="evolve-algorithm-tags">
        {tags.map((tag) => <span className="evolve-algorithm-tag" key={tag}>{tag}</span>)}
      </span>
      <span className="evolve-algorithm-points">
        {bullets.map((bullet) => <span key={bullet}>{bullet}</span>)}
      </span>
    </span>
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
