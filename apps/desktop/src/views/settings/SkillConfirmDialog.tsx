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

import { TEXT } from "../../text.js";

/**
 * The 技能 page's own confirmation, as the handoff draws 2-4 and 2-5.
 *
 * It is a local dialog rather than the workspace's confirm: these two ask
 * about one file and one unsaved edit, and the handoff gives them their own
 * 400px card. The accept action may be asynchronous (a delete request); the
 * buttons stay disabled until it settles.
 */
export function SkillConfirmDialog({
  body,
  compactBody,
  onAccept,
  onCancel,
  title,
}: {
  body: string;
  /** 2-4's notice is 12px; 2-5's is 14px, as drawn. */
  compactBody?: boolean;
  onAccept: () => void | Promise<void>;
  onCancel: () => void;
  title: string;
}) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div
      className="skill-confirm-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section aria-label={title} aria-modal="true" className="skill-confirm" role="dialog">
        <header>
          <h3>{title}</h3>
          <button
            aria-label={TEXT.settings.skills.closeDialog}
            className="skill-dialog-close"
            onClick={onCancel}
            type="button"
          >
            <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" viewBox="0 0 24 24" width="14">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <p className={compactBody ? "is-compact" : undefined}>{body}</p>
        <footer>
          <button className="secondary-button" disabled={busy} onClick={onCancel} type="button">
            {TEXT.settings.skills.uploadDialog.cancel}
          </button>
          <button
            className="skill-confirm-accept"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void Promise.resolve(onAccept()).finally(() => setBusy(false));
            }}
            type="button"
          >
            {TEXT.settings.skills.uploadDialog.confirm}
          </button>
        </footer>
      </section>
    </div>
  );
}
