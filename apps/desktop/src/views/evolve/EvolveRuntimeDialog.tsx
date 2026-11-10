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
 * What to do when the evolution runtime is not usable.
 *
 * The create dialog can only say "this will not work"; a person on a desktop
 * needs the next step. The runtime is installed and supervised by the local
 * service, so the answer is mostly "look at these files" — the paths below are
 * the ones this product actually writes on a Windows desktop, not generic
 * advice. The install lives here as well: it is the one action the dialog can
 * take on the user's behalf, and it belongs next to the explanation rather than
 * in place of the form.
 */

import { useEffect } from "react";

import type { EvolveStatus } from "../../api/evolve.js";
import { TEXT } from "../../text.js";
import { claimsEscape } from "../dialog-escape.js";

export interface EvolveRuntimeDialogProps {
  /** The last read or write error from `useEvolve`, shown only for a runtime
   *  the server itself reported as broken. */
  error?: string;
  initializing: boolean;
  onClose: () => void;
  onInitialize: () => void;
  status: EvolveStatus;
}

export function EvolveRuntimeDialog({
  error,
  initializing,
  onClose,
  onInitialize,
  status,
}: EvolveRuntimeDialogProps) {
  const installing = initializing || status.state === "installing";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!claimsEscape(event)) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const intro = status.state === "error" ? TEXT.evolve.setup.introError
    : installing ? TEXT.evolve.setup.introInstalling
      : TEXT.evolve.setup.introMissing;
  // Two sources answer different questions — the server's status read and the
  // last failed call — and a person diagnosing this needs both verbatim.
  const reports = [status.error, status.state === "error" ? error : undefined]
    .filter((report): report is string => report !== undefined && report !== "");

  return <div className="modal-backdrop evolve-confirm-backdrop" onPointerDown={onClose}>
    <div
      aria-labelledby="evolve-runtime-title"
      aria-modal="true"
      className="modal-panel evolve-runtime-dialog"
      onPointerDown={(event) => event.stopPropagation()}
      role="dialog"
    >
      <header className="modal-header">
        <span className="modal-eyebrow">{TEXT.evolve.title}</span>
        <h2 id="evolve-runtime-title">{TEXT.evolve.setup.title}</h2>
        <button aria-label={TEXT.evolve.setup.close} className="modal-close" onClick={onClose} type="button">
          ×
        </button>
      </header>

      <div className="evolve-runtime-body">
        <p className="evolve-runtime-intro">{intro}</p>

        {reports.length === 0 ? null : <section className="evolve-runtime-report">
          <span>{TEXT.evolve.setup.statusLabel}</span>
          {reports.map((report) => <code key={report}>{report}</code>)}
        </section>}

        <section className="evolve-runtime-section">
          <h3>{TEXT.evolve.setup.whereTitle}</h3>
          <ul className="evolve-runtime-logs">
            {TEXT.evolve.setup.logs.map((entry) => <li key={entry.path}>
              <code>{entry.path}</code>
              <span>{entry.what}</span>
            </li>)}
          </ul>
        </section>

        <section className="evolve-runtime-section">
          <h3>{TEXT.evolve.setup.whyTitle}</h3>
          <p>{TEXT.evolve.setup.whyBody}</p>
        </section>

        <section className="evolve-runtime-section">
          <h3>{TEXT.evolve.setup.fixTitle}</h3>
          <p>{TEXT.evolve.setup.fixBody}</p>
        </section>

        {status.canInitialize ? null : <p className="evolve-runtime-operator">
          {TEXT.evolve.setup.operator}
        </p>}
      </div>

      <footer className="modal-footer">
        <button className="secondary-button" onClick={onClose} type="button">
          {TEXT.evolve.setup.close}
        </button>
        {/* Disabled rather than absent when the deployment does not install:
            the operator note above explains a missing button poorly. */}
        <button
          className="primary-button"
          disabled={installing || !status.canInitialize}
          onClick={onInitialize}
          type="button"
        >
          {installing ? TEXT.evolve.setup.installing : TEXT.evolve.setup.install}
        </button>
      </footer>
    </div>
  </div>;
}
