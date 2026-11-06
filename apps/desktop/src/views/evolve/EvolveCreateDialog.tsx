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
 * dialog collects the two things a person actually knows — what should get
 * better, and which search suits the shape of the problem — and then hands the
 * sentence to that conversation as the command it would have typed.
 *
 * The runtime install lives here too, because it is the first thing a new
 * installation needs and the worst thing to discover after writing a goal.
 */

import { useEffect, useState } from "react";

import type { EvolveStatus } from "../../api/evolve.js";
import type { EvolveAlgorithm, EvolveCheckpointMode } from "@sciencediscovery/schema";
import { evolveCommand } from "../../evolve/command.js";
import { TEXT } from "../../text.js";
import { claimsEscape } from "../dialog-escape.js";

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
  /** A goal the user already typed after the command, carried through the
   *  setup detour so it is not written twice. */
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
  const [goal, setGoal] = useState(initialGoal ?? "");
  const [algorithm, setAlgorithm] = useState<EvolveAlgorithm>(initialAlgorithm ?? "puct");
  // Confirm by default: pausing is the safe pace, and an unattended design
  // spends real model calls before the user has seen a single checkpoint.
  const [confirm, setConfirm] = useState(initialCheckpointMode !== "auto");
  // The consent to run without a sandbox is asked at the moment it is used,
  // not collected ahead of time: a switch that sits on the form invites the
  // reading "this is a setting", and a setting gets set once and forgotten.
  // Here the answer is per-send or it does not exist.
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!claimsEscape(event)) return;
      event.preventDefault();
      // The alert is the topmost surface: Escape answers it, not the dialog
      // underneath.
      if (confirming) {
        setConfirming(false);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirming, onClose]);

  const unisolated = status.sandbox === "direct";
  const ready = status.state === "ready";
  const installing = initializing || status.state === "installing";
  const blocked = archived ? TEXT.evolve.create.blockedArchived
    : running ? TEXT.evolve.create.blockedRunning
      : undefined;
  const canSend = ready && goal.trim() !== "" && blocked === undefined;

  return <>
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        aria-labelledby="evolve-create-title"
        className="modal-panel evolve-create"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="modal-header">
          <span className="modal-eyebrow">{TEXT.evolve.title}</span>
          <h2 id="evolve-create-title">{TEXT.evolve.create.title}</h2>
          <button aria-label={TEXT.evolve.create.cancel} className="modal-close" onClick={onClose} type="button">
            ×
          </button>
        </header>

        {/* Directly under the title, before any field: on a host with no
            sandbox the warning is part of what this dialog is, not a footnote
            the reader meets after typing a goal. Everywhere else there is
            nothing to warn about, and a banner there would describe a risk the
            deployment does not carry. */}
        {unisolated ? <div className="evolve-create-alert" role="note">
          <strong>{TEXT.evolve.create.unisolatedBannerTitle}</strong>
          <span>{TEXT.evolve.create.unisolatedBannerBody}</span>
        </div> : null}

        {ready ? <form
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
            onSend(evolveCommand(algorithm, goal, confirm ? "confirm" : "auto"));
          }}
        >
          <p className="evolve-create-intro">{TEXT.evolve.create.intro}</p>

          <label className="evolve-create-field">
            <span>{TEXT.evolve.create.goalLabel}</span>
            <textarea
              autoFocus
              onChange={(event) => setGoal(event.target.value)}
              placeholder={TEXT.evolve.create.goalPlaceholder}
              rows={4}
              value={goal}
            />
          </label>

          <fieldset className="evolve-create-algorithms">
            <legend>{TEXT.evolve.create.algorithmLabel}</legend>
            <div aria-label={TEXT.evolve.create.algorithmLabel} role="radiogroup">
              <AlgorithmChoice
                checked={algorithm === "puct"}
                hint={TEXT.evolve.create.puctHint}
                label={TEXT.evolve.create.puct}
                onSelect={() => setAlgorithm("puct")}
              />
              <AlgorithmChoice
                checked={algorithm === "openevolve"}
                hint={TEXT.evolve.create.openEvolveHint}
                label={TEXT.evolve.create.openEvolve}
                onSelect={() => setAlgorithm("openevolve")}
              />
            </div>
          </fieldset>

          <label className="evolve-create-confirm">
            <input
              checked={confirm}
              onChange={(event) => setConfirm(event.target.checked)}
              role="switch"
              type="checkbox"
            />
            <span className="evolve-create-confirm-text">
              <strong>{TEXT.evolve.create.confirmLabel}</strong>
              <span>{confirm ? TEXT.evolve.create.confirmHint : TEXT.evolve.create.autoHint}</span>
            </span>
          </label>

          <p className="evolve-create-note">{TEXT.evolve.create.sessionNote}</p>
          {blocked === undefined ? null : <p className="evolve-create-blocked">{blocked}</p>}

          <footer className="modal-footer">
            <button className="secondary-button" onClick={onClose} type="button">
              {TEXT.evolve.create.cancel}
            </button>
            <button className="primary-button" disabled={!canSend} type="submit">
              {TEXT.evolve.create.send}
            </button>
          </footer>
        </form> : <div className="evolve-create-body">
          <section aria-live="polite" className="evolve-create-setup">
            <span aria-hidden="true" className={`evolve-setup-mark${installing ? " is-busy" : ""}`} />
            <div>
              <strong>{TEXT.evolve.setup.title}</strong>
              <p>{installing ? TEXT.evolve.setup.installing : TEXT.evolve.setup.body}</p>
              {status.state === "ready" ? null : <p className="evolve-create-state">
                {status.state === "error"
                  ? TEXT.evolve.setup.error
                  : installing ? TEXT.evolve.setup.installing : TEXT.evolve.setup.missing}
              </p>}
              {status.error ? <p className="evolve-create-error">{status.error}</p> : null}
              {status.state === "error" && error ? <p className="evolve-create-error">{error}</p> : null}
              {status.canInitialize ? null : <p className="evolve-create-note">
                {TEXT.evolve.setup.operator}
              </p>}
            </div>
          </section>

          <footer className="modal-footer">
            <button className="secondary-button" onClick={onClose} type="button">
              {TEXT.evolve.create.cancel}
            </button>
            <button
              className="primary-button"
              disabled={installing || !status.canInitialize}
              onClick={onInitialize}
              type="button"
            >
              {installing ? TEXT.evolve.setup.installing : TEXT.evolve.setup.install}
            </button>
          </footer>
        </div>}
      </div>
    </div>

  {/* The last gate before the command is sent. Its answer travels with the
      command as `--allow-direct`; closing it any way other than the continue
      button leaves the answer as "no". */}
  {confirming ? <div className="modal-backdrop evolve-confirm-backdrop" onPointerDown={() => setConfirming(false)}>
    <div
      aria-describedby="evolve-unisolated-body"
      aria-labelledby="evolve-unisolated-title"
      aria-modal="true"
      className="modal-panel modal-panel-narrow evolve-unisolated-confirm"
      onPointerDown={(event) => event.stopPropagation()}
      role="alertdialog"
    >
      <header className="modal-header">
        <h2 id="evolve-unisolated-title">{TEXT.evolve.create.unisolatedConfirmTitle}</h2>
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
          className="danger-button"
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

function AlgorithmChoice({ checked, hint, label, onSelect }: {
  checked: boolean;
  hint: string;
  label: string;
  onSelect: () => void;
}) {
  return <button
    aria-checked={checked}
    className={`evolve-algorithm-choice${checked ? " is-checked" : ""}`}
    onClick={onSelect}
    role="radio"
    type="button"
  >
    <span className="evolve-algorithm-name">{label}</span>
    <span className="evolve-algorithm-hint">{hint}</span>
  </button>;
}
