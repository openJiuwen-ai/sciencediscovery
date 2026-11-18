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

import { isAbortError, type ApiClient } from "../../api/client.js";
import { importSkillFromGit, inspectGitSkillRepository } from "../../api/settings.js";
import type {
  GitSkillImportCandidate,
  GitSkillRepositoryInspection,
  SkillDetail,
} from "../../api/types.js";
import { TEXT } from "../../text.js";

interface Props {
  client: ApiClient;
  /** Runs for every package the server installs; the caller enables it and
   *  reloads the list behind this view. */
  onImported: (skill: SkillDetail) => void | Promise<void>;
}

const STATUS_LABEL: Record<GitSkillImportCandidate["status"], () => string> = {
  invalid: () => TEXT.settings.skills.git.invalid,
  new: () => TEXT.settings.skills.git.new,
  unchanged: () => TEXT.settings.skills.git.unchanged,
  update: () => TEXT.settings.skills.git.update,
};

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : TEXT.settings.skills.importFailed;
}

/**
 * 技能 › 从 GitHub 导入.
 *
 * Inspection comes before any write, because a repository may hold several
 * packages and only the user can say which ones belong in this catalog. The
 * inspection pins a commit and every selected package is imported at that
 * exact commit, so the rows the user ticked are the bytes that get installed.
 *
 * A package already installed is an `update` and is imported with the revision
 * the inspection saw: if another window edited it meanwhile the server answers
 * 409, and the row says so rather than silently replacing that edit.
 */
export function SkillGitImportView({ client, onImported }: Props) {
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [subdirectory, setSubdirectory] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inspection, setInspection] = useState<GitSkillRepositoryInspection>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const inspectionRequest = useRef<AbortController | undefined>(undefined);

  const reset = () => {
    setInspection(undefined);
    setSelected(new Set());
    setRowErrors({});
    setFailure(undefined);
    setNotice(undefined);
  };

  const inspect = async () => {
    const controller = new AbortController();
    inspectionRequest.current = controller;
    setInspecting(true);
    setInspection(undefined);
    setSelected(new Set());
    setRowErrors({});
    setFailure(undefined);
    setNotice(undefined);
    try {
      const found = await inspectGitSkillRepository(client, {
        repositoryUrl: url.trim(),
        ...(ref.trim() ? { ref: ref.trim() } : {}),
        ...(subdirectory.trim() ? { subdirectory: subdirectory.trim() } : {}),
      }, controller.signal);
      setInspection(found);
      // Everything that can be written is ticked: the usual import is "all of
      // it", and the user unticks rather than ticks.
      setSelected(new Set(found.candidates
        .filter((candidate) => candidate.status === "new" || candidate.status === "update")
        .map((candidate) => candidate.subdirectory)));
    } catch (reason) {
      // A cancelled inspection is not a failure: the user said stop.
      if (!isAbortError(reason)) setFailure(messageOf(reason));
    } finally {
      if (inspectionRequest.current === controller) inspectionRequest.current = undefined;
      setInspecting(false);
    }
  };

  /** Stop waiting for the clone. The server finishes its own work; what this
   *  ends is the page being unusable while it does. */
  const cancelInspect = () => {
    inspectionRequest.current?.abort();
  };

  const toggle = (entry: string, next: boolean) => {
    setSelected((current) => {
      const copy = new Set(current);
      if (next) copy.add(entry);
      else copy.delete(entry);
      return copy;
    });
  };

  const selectable = inspection?.candidates.filter(
    (candidate) => candidate.status === "new" || candidate.status === "update",
  ) ?? [];
  const allSelected = selectable.length > 0 && selected.size === selectable.length;
  const toggleAll = () => setSelected(allSelected
    ? new Set()
    : new Set(selectable.map((candidate) => candidate.subdirectory)));

  const chosen = inspection?.candidates.filter((candidate) => selected.has(candidate.subdirectory)) ?? [];

  const importFromGit = async () => {
    if (!inspection || chosen.length === 0) return;
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    const errors: Record<string, string> = {};
    let imported = 0;
    setProgress({ done: 0, total: chosen.length });
    for (const candidate of chosen) {
      try {
        const detail = await importSkillFromGit(client, {
          commit: inspection.commit,
          ...(inspection.ref ? { ref: inspection.ref } : {}),
          repositoryUrl: inspection.repositoryUrl,
          subdirectory: candidate.subdirectory,
          ...(candidate.status === "update" && candidate.currentRevision !== undefined
            ? { expectedRevision: candidate.currentRevision, overwrite: true }
            : {}),
        });
        imported += 1;
        await onImported(detail);
      } catch (reason) {
        errors[candidate.subdirectory] = messageOf(reason);
      }
      setProgress({ done: imported + Object.keys(errors).length, total: chosen.length });
    }
    setRowErrors(errors);
    // What failed stays ticked, so a retry after fixing the cause is one press.
    setSelected(new Set(Object.keys(errors)));
    const failed = chosen.length - imported;
    setNotice(imported === 0
      ? undefined
      : failed === 0
        ? TEXT.settings.skills.importedCount(imported)
        : TEXT.settings.skills.importPartial(imported, failed));
    setBusy(false);
  };

  return (
    <div className="skill-git">
      <div className="skill-git-source">
        <div className="skill-git-url">
          <label className="settings-field">
            <span className="settings-field-label">{TEXT.settings.skills.git.url}</span>
            <input
              aria-label={TEXT.settings.skills.git.url}
              className="field-input"
              disabled={inspecting || busy}
              onChange={(event) => {
                setUrl(event.target.value);
                reset();
              }}
              placeholder={TEXT.settings.skills.git.urlPlaceholder}
              spellCheck={false}
              value={url}
            />
          </label>
          <button
            className="secondary-button"
            disabled={inspecting || busy || url.trim() === ""}
            onClick={() => void inspect()}
            type="button"
          >
            {inspecting ? TEXT.settings.skills.git.inspecting : TEXT.settings.skills.git.inspect}
          </button>
        </div>
        <div className="settings-field-pair">
          <label className="settings-field">
            <span className="settings-field-label">{TEXT.settings.skills.git.ref}</span>
            <input
              aria-label={TEXT.settings.skills.git.ref}
              className="field-input"
              disabled={inspecting || busy}
              onChange={(event) => {
                setRef(event.target.value);
                reset();
              }}
              placeholder={TEXT.settings.skills.git.refPlaceholder}
              spellCheck={false}
              value={ref}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field-label">{TEXT.settings.skills.git.subdirectory}</span>
            <input
              aria-label={TEXT.settings.skills.git.subdirectory}
              className="field-input"
              disabled={inspecting || busy}
              onChange={(event) => {
                setSubdirectory(event.target.value);
                reset();
              }}
              placeholder={TEXT.settings.skills.git.subdirectoryPlaceholder}
              spellCheck={false}
              value={subdirectory}
            />
          </label>
        </div>
      </div>

      {inspecting ? (
        <div className="skill-git-progress" role="status">
          <small className="row-note">{TEXT.settings.skills.git.inspectHint}</small>
          <button className="secondary-button" onClick={cancelInspect} type="button">
            {TEXT.settings.skills.git.cancelInspect}
          </button>
        </div>
      ) : null}

      {failure ? <small className="row-note is-error" role="alert">{failure}</small> : null}

      {inspection ? (
        <section aria-label={TEXT.settings.skills.git.found(inspection.candidates.length)} className="skill-git-results">
          <div className="skill-git-results-head">
            <div>
              <h3>{TEXT.settings.skills.git.found(inspection.candidates.length)}</h3>
              <p className="row-note">
                {TEXT.settings.skills.git.commit(inspection.commit)} · {TEXT.settings.skills.git.selectHint}
              </p>
            </div>
            <button
              className="primary-button"
              disabled={busy || selected.size === 0}
              onClick={() => void importFromGit()}
              type="button"
            >
              {busy
                ? progress.total === 0
                  ? TEXT.settings.skills.importBusy
                  : TEXT.settings.skills.importProgress(progress.done, progress.total)
                : TEXT.settings.skills.git.importSelected(selected.size)}
            </button>
          </div>

          {inspection.candidates.length === 0 ? (
            <p className="settings-empty">{TEXT.settings.skills.git.empty}</p>
          ) : (
            <>
              <div className="skill-git-select-bar">
                <label className="skill-git-select-all">
                  <input
                    aria-label={TEXT.settings.skills.git.selectAll}
                    checked={allSelected}
                    disabled={busy || selectable.length === 0}
                    onChange={toggleAll}
                    type="checkbox"
                  />
                  {TEXT.settings.skills.git.selectAll}
                </label>
              </div>
              <div className="skill-candidates">
                {inspection.candidates.map((candidate) => {
                  const canChoose = candidate.status === "new" || candidate.status === "update";
                  return (
                    <label
                      className={`skill-candidate${canChoose ? "" : " is-disabled"}`}
                      key={candidate.subdirectory}
                    >
                      <input
                        checked={selected.has(candidate.subdirectory)}
                        disabled={!canChoose || busy}
                        onChange={(event) => toggle(candidate.subdirectory, event.target.checked)}
                        type="checkbox"
                      />
                      <span className="skill-candidate-main">
                        <strong>
                          {candidate.name ?? candidate.subdirectory}
                          <span className={`skill-candidate-status is-${candidate.status}`}>
                            {STATUS_LABEL[candidate.status]()}
                          </span>
                        </strong>
                        <small>{candidate.description ?? candidate.subdirectory}</small>
                        {candidate.diagnostics.length ? (
                          <small className="is-error">{candidate.diagnostics.join(" ")}</small>
                        ) : null}
                        {rowErrors[candidate.subdirectory] ? (
                          <small className="is-error">{rowErrors[candidate.subdirectory]}</small>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          )}
        </section>
      ) : null}

      {notice ? <small className="row-note" role="status">{notice}</small> : null}
    </div>
  );
}
