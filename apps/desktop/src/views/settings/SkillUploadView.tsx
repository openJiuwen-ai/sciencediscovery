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

import { useState } from "react";

import type { ApiClient } from "../../api/client.js";
import { importSkillFile } from "../../api/settings.js";
import type { SkillDetail } from "../../api/types.js";
import { TEXT } from "../../text.js";

interface Props {
  client: ApiClient;
  /** Runs for the package the server installs; the caller enables it, reloads
   *  the list behind this view and keeps that view mounted. */
  onImported: (skill: SkillDetail) => void | Promise<void>;
  /** Leaves for 从零开始写, which the same menu offered one entry up. */
  onWriteInstead: () => void;
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : TEXT.settings.skills.importFailed;
}

/**
 * 技能 › 上传技能.
 *
 * One package at a time, from the file picker or a drop. The whole surface is
 * the drop target rather than a bare input: a user who dragged a ZIP from a
 * file window has already chosen the file, and asking them to find the same
 * file through a dialog is the second half of one action. The route is the
 * same multipart upload either way — a SKILL.md and a ZIP differ only in what
 * the server unpacks.
 *
 * Nothing is sent until 导入 is pressed. A wrong file is replaced by dropping
 * another one or by 移除; a failed import keeps the file so a retry does not
 * mean finding it again.
 */
export function SkillUploadView({ client, onImported, onWriteInstead }: Props) {
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [dragging, setDragging] = useState(false);

  const choose = (next: File | undefined) => {
    setFile(next);
    setFailure(undefined);
    setNotice(undefined);
  };

  const importFile = async () => {
    if (!file || busy) return;
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    try {
      const detail = await importSkillFile(client, file);
      setNotice(TEXT.settings.skills.importSucceeded(detail.name));
      setFile(undefined);
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
      <label
        className={`skill-drop${dragging ? " is-dragging" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={(event) => {
          // A drag over a child fires leave on the parent too; only the pointer
          // leaving the whole zone ends the highlight.
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
        <input
          accept=".md,.markdown,.zip,.skill"
          aria-label={TEXT.settings.skills.uploadView.dropTitle}
          className="sr-only"
          disabled={busy}
          onChange={(event) => {
            choose(event.target.files?.[0]);
            event.target.value = "";
          }}
          type="file"
        />
        <span aria-hidden="true" className="skill-drop-icon">
          <svg fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24" width="20">
            <path d="M12 15V4m-4 4 4-4 4 4M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" />
          </svg>
        </span>
        <span className="skill-drop-title">
          {busy ? TEXT.settings.skills.uploadView.reading : TEXT.settings.skills.uploadView.dropTitle}
        </span>
        <span className="skill-drop-hint">{TEXT.settings.skills.uploadView.dropHint}</span>
      </label>

      {file ? (
        <div className="skill-file-row">
          <span className="skill-file-name">{file.name}</span>
          <span className="skill-file-size">
            {TEXT.settings.skills.uploadView.fileSize(kilobytes)}
          </span>
          <button
            aria-label={TEXT.settings.skills.uploadView.remove}
            className="skill-file-remove"
            disabled={busy}
            onClick={() => choose(undefined)}
            type="button"
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="skill-view-actions">
        <button
          className="primary-button"
          disabled={busy || !file}
          onClick={() => void importFile()}
          type="button"
        >
          {busy ? TEXT.settings.skills.importBusy : TEXT.settings.skills.importAction}
        </button>
      </div>

      {failure ? <small className="row-note is-error" role="alert">{failure}</small> : null}
      {notice ? <small className="row-note" role="status">{notice}</small> : null}

      <div className="skill-view-footer">
        <button className="secondary-button" onClick={onWriteInstead} type="button">
          {TEXT.settings.skills.uploadView.writeInstead}
        </button>
      </div>
    </div>
  );
}
