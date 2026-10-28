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

import { useEffect } from "react";

import type { ConfirmRequest } from "../app/use-workspace.js";
import { TEXT } from "../text.js";
import { claimsEscape } from "./dialog-escape.js";

/**
 * The gate in front of everything irreversible.
 *
 * The body always states the consequence — what is destroyed, what cannot be
 * undone — because a bare "are you sure?" trains people to click through,
 * which is exactly the wrong habit in front of 删除.
 */
export function ConfirmDialog({
  onDismiss,
  request,
}: {
  onDismiss: () => void;
  request: ConfirmRequest;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!claimsEscape(event)) return;
      // This dialog is the topmost one. Claim the key on its way up so the
      // settings dialog behind it — listening on `window`, further along the
      // same path — does not close as well.
      event.preventDefault();
      onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div className="modal-backdrop" onPointerDown={onDismiss}>
      <div
        aria-labelledby="confirm-title"
        className="modal-panel modal-panel-narrow"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="modal-header">
          <span className="modal-eyebrow">{request.eyebrow ?? TEXT.menu.confirm}</span>
          <h2 id="confirm-title">{request.title}</h2>
          <button aria-label={TEXT.menu.cancel} className="modal-close" onClick={onDismiss} type="button">
            ×
          </button>
        </header>
        <div className="modal-body">{request.body}</div>
        <footer className="modal-footer">
          <button className="secondary-button" onClick={onDismiss} type="button">
            {TEXT.menu.cancel}
          </button>
          <button
            className="primary-button"
            onClick={() => {
              // Dismiss first: the work may replace the screen underneath, and
              // a modal that outlives its own action is a trap.
              onDismiss();
              void request.onAccept();
            }}
            type="button"
          >
            {request.accept}
          </button>
        </footer>
      </div>
    </div>
  );
}
