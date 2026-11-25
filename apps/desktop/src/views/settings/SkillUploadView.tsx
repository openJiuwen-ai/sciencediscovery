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

import { useRef, useState } from "react";

import type { ApiClient } from "../../api/client.js";
import { importSkillFile } from "../../api/settings.js";
import type { SkillDetail } from "../../api/types.js";
import { TEXT } from "../../text.js";

interface Props {
  client: ApiClient;
  /** Closes the dialog without importing. */
  onCancel: () => void;
  /** Runs for the package the server installs; the caller enables it, reloads
   *  the list behind the dialog and closes the dialog. */
  onImported: (skill: SkillDetail) => void | Promise<void>;
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : TEXT.settings.skills.importFailed;
}

/**
 * 技能 › 上传技能, as the handoff's dialog.
 *
 * One package at a time, from the file picker or a drop. The drop zone is the
 * whole target rather than a bare input: a user who dragged a ZIP from a file
 * window has already chosen the file, and asking them to find the same file
 * through a dialog is the second half of one action. The route is the same
 * multipart upload either way — a SKILL.md and a ZIP differ only in what the
 * server unpacks.
 *
 * Nothing is sent until 确定 is pressed. A wrong file is replaced by dropping
 * another one or by 重新选择; a failed import keeps the file so a retry does
 * not mean finding it again.
 */
export function SkillUploadView({ client, onCancel, onImported }: Props) {
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const choose = (next: File | undefined) => {
    setFile(next);
    setFailure(undefined);
  };

  const importFile = async () => {
    if (!file || busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const detail = await importSkillFile(client, file);
      await onImported(detail);
    } catch (reason) {
      setFailure(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  const kilobytes = file ? Math.max(1, Math.ceil(file.size / 1024)) : 0;

  return (
    <div className="skill-upload">
      <p className="skill-upload-hint">
        <svg
          aria-hidden="true"
          fill="currentColor"
          height="16"
          viewBox="0 0 24 24"
          width="16"
        >
          <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 5.2a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Zm1.1 10.3h-2.2v-6.2h2.2Z" />
        </svg>
        {TEXT.settings.skills.uploadDialog.hint}
      </p>

      <div className="skill-upload-section">
        <span className="skill-upload-label">{TEXT.settings.skills.uploadDialog.chooseFile}</span>
        <input
          accept=".md,.markdown,.zip,.skill"
          aria-label={TEXT.settings.skills.uploadDialog.dropTitle}
          className="sr-only"
          disabled={busy}
          id="skill-upload-file"
          onChange={(event) => {
            choose(event.target.files?.[0]);
            event.target.value = "";
          }}
          ref={picker}
          type="file"
        />
        {file ? (
          <div className="skill-upload-file">
            <span aria-hidden="true" className="skill-upload-file-icon">
              <svg fill="none" height="30" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" viewBox="0 0 24 24" width="30">
                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
                <path d="M14 3v5h5" />
              </svg>
            </span>
            <span className="skill-upload-file-copy">
              <strong>{file.name}</strong>
              <small>{TEXT.settings.skills.uploadView.fileSize(kilobytes)}</small>
            </span>
            <button
              className="secondary-button skill-upload-reselect"
              disabled={busy}
              onClick={() => picker.current?.click()}
              type="button"
            >
              {TEXT.settings.skills.uploadDialog.reselect}
            </button>
          </div>
        ) : (
          <label
            className={`skill-drop${dragging ? " is-dragging" : ""}`}
            htmlFor="skill-upload-file"
            onDragEnter={(event) => {
              event.preventDefault();
              if (!busy) setDragging(true);
            }}
            onDragLeave={(event) => {
              // A drag over a child fires leave on the parent too; only the
              // pointer leaving the whole zone ends the highlight.
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (busy) return;
              const dropped = event.dataTransfer.files?.[0];
              if (dropped) choose(dropped);
            }}
          >
            <span aria-hidden="true" className="skill-drop-icon">
              <svg fill="none" height="25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="25">
                <path d="M12 15V4m-4 4 4-4 4 4M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" />
              </svg>
            </span>
            <strong>{TEXT.settings.skills.uploadDialog.dropTitle}</strong>
            <span className="skill-drop-hint">{TEXT.settings.skills.uploadDialog.dropHint}</span>
          </label>
        )}
      </div>

      {failure ? <small className="row-note is-error" role="alert">{failure}</small> : null}

      <div className="skill-dialog-actions">
        <button className="secondary-button" disabled={busy} onClick={onCancel} type="button">
          {TEXT.settings.skills.uploadDialog.cancel}
        </button>
        <button
          className="primary-button"
          disabled={busy || !file}
          onClick={() => void importFile()}
          type="button"
        >
          {busy ? TEXT.settings.skills.importBusy : TEXT.settings.skills.uploadDialog.confirm}
        </button>
      </div>
    </div>
  );
}
