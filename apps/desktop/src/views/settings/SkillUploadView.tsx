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
import type { SkillActivationOutcome } from "../../app/skill-activation.js";
import { TEXT } from "../../text.js";

interface Props {
  client: ApiClient;
  /** Closes the dialog without importing. */
  onCancel: () => void;
  /** Runs for the package the server installs; the caller enables it, reloads
   *  the list behind the dialog and closes the dialog. Its answer is the
   *  activation outcome, so a switch that did not happen keeps the dialog — and
   *  its recovery — where the user is looking. */
  onImported: (skill: SkillDetail) => void | Promise<void | SkillActivationOutcome>;
  /** Switch the installed package on again, without importing it a second time. */
  onRetryActivation?: (skill: SkillDetail) => Promise<SkillActivationOutcome>;
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
 *
 * The import and the switch are two writes. When the package arrives but its
 * switch is refused, this dialog says so instead of closing on a success
 * notice, and offers the switch again — the package is already installed, so
 * the recovery must not send it up a second time.
 *
 * While that answer is on screen the picker and 确定 are inert, and the notice
 * is the only way on: it offers the switch again and its own dismissal. Two
 * reasons hold for that. The notice is the only account of why the installed
 * package cannot be used, and a new file clears it — the reader would be left
 * with a package they cannot switch on and no explanation. And the upload route
 * renames a taken name (`onDuplicate=rename`), so sending the same bytes again
 * installs a second package (`portable-skill-2`) instead of the switch the
 * first one is missing. Dismissing the notice is what makes the dialog a
 * picker again.
 */
export function SkillUploadView({ client, onCancel, onImported, onRetryActivation }: Props) {
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [dragging, setDragging] = useState(false);
  /** The package the server installed. Kept so the switch can be retried here,
   *  after the file is gone, without sending the package up again. */
  const [imported, setImported] = useState<SkillDetail>();
  /** The switch that did not happen; the import itself succeeded. */
  const [activation, setActivation] = useState<SkillActivationOutcome>();
  const [retrying, setRetrying] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  /** A refused switch is the one thing this dialog must not lose. */
  const sealed = activation !== undefined;

  const choose = (next: File | undefined) => {
    // While the switch is unresolved the picker is inert; this is the second
    // guard, for a drop that arrives without a click.
    if (sealed && next !== undefined) return;
    setFile(next);
    setFailure(undefined);
    setImported(undefined);
    setActivation(undefined);
  };

  /** Put the dialog back to a picker: the installed package keeps whatever
   *  state it has, and the pane behind the dialog still reports it. */
  const dismissActivation = () => {
    setActivation(undefined);
    setImported(undefined);
  };

  const importFile = async () => {
    if (!file || busy || sealed) return;
    setBusy(true);
    setFailure(undefined);
    setActivation(undefined);
    setImported(undefined);
    try {
      const detail = await importSkillFile(client, file);
      // The server has the package now. Dropping the file is what stops a
      // second press from sending the same bytes up again while the dialog
      // waits for the switch to be retried.
      setFile(undefined);
      setImported(detail);
      // The package is installed from here on. What the caller answers is what
      // happened to its switch; an error there is an activation failure, not a
      // failed import, and must not be reported as one.
      try {
        const outcome = await onImported(detail);
        if (outcome?.state === "failed") setActivation(outcome);
      } catch (reason) {
        setActivation({ state: "failed", error: messageOf(reason) });
      }
    } catch (reason) {
      setFailure(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  const retryActivation = async () => {
    if (!imported || !onRetryActivation || retrying) return;
    setRetrying(true);
    try {
      const outcome = await onRetryActivation(imported);
      setActivation(outcome.state === "failed" ? outcome : undefined);
    } finally {
      setRetrying(false);
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
          aria-describedby={sealed ? "skill-upload-sealed" : undefined}
          className="sr-only"
          disabled={busy || sealed}
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
              disabled={busy || sealed}
              onClick={() => picker.current?.click()}
              type="button"
            >
              {TEXT.settings.skills.uploadDialog.reselect}
            </button>
          </div>
        ) : (
          <label
            aria-disabled={sealed}
            className={`skill-drop${dragging ? " is-dragging" : ""}${sealed ? " is-sealed" : ""}`}
            htmlFor="skill-upload-file"
            onDragEnter={(event) => {
              event.preventDefault();
              if (!busy && !sealed) setDragging(true);
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
              if (busy || sealed) return;
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
      {activation ? (
        <div className="skill-activation-notice" id="skill-upload-sealed" role="alert">
          <small className="row-note is-error">
            {activation.stateUnknown
              ? TEXT.settings.skills.activationUnknown
              : TEXT.settings.skills.activationFailed([imported?.name ?? ""])}
          </small>
          {activation.error ? <small className="row-note is-error">{activation.error}</small> : null}
          <div className="skill-activation-actions">
            {onRetryActivation ? (
              <button
                className="secondary-button"
                disabled={retrying || busy}
                onClick={() => void retryActivation()}
                type="button"
              >
                {retrying
                  ? TEXT.settings.skills.activationRetrying
                  : TEXT.settings.skills.activationRetry}
              </button>
            ) : null}
            <button
              aria-label={TEXT.settings.skills.toastClose}
              className="skill-activation-dismiss"
              onClick={dismissActivation}
              type="button"
            >
              <svg
                aria-hidden="true"
                fill="none"
                height="12"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.8"
                viewBox="0 0 24 24"
                width="12"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </div>
      ) : null}

      <div className="skill-dialog-actions">
        <button className="secondary-button" disabled={busy} onClick={onCancel} type="button">
          {TEXT.settings.skills.uploadDialog.cancel}
        </button>
        <button
          className="primary-button"
          disabled={busy || !file || sealed}
          onClick={() => void importFile()}
          type="button"
        >
          {busy ? TEXT.settings.skills.importBusy : TEXT.settings.skills.uploadDialog.confirm}
        </button>
      </div>
    </div>
  );
}
