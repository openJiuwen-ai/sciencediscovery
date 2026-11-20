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
import { inspectGitSkillRepository } from "../../api/settings.js";
import type {
  GitSkillImportCandidate,
  GitSkillRepositoryInspection,
  StartGitSkillImportJobRequest,
} from "../../api/types.js";
import { TEXT } from "../../text.js";

interface Props {
  client: ApiClient;
  /** Leaves for the list as soon as the job is accepted. The import itself
   *  runs in the API process; the list shows its progress and result. */
  onDone?: () => void;
  /** Starts the background job. The view only builds the selection. */
  onStart: (request: StartGitSkillImportJobRequest) => Promise<void>;
}

const STATUS_LABEL: Record<GitSkillImportCandidate["status"], () => string> = {
  invalid: () => TEXT.settings.skills.git.invalid,
  new: () => TEXT.settings.skills.git.new,
  unchanged: () => TEXT.settings.skills.git.unchanged,
  update: () => TEXT.settings.skills.git.update,
};

/** What the server said, in the reader's language where the cause is one the
 *  reader can act on. The checkout runs in the API process, so its own proxy
 *  and network are what matter — a browser proxy setting does not travel with
 *  the git child, and the message has to say so. */
function messageOf(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : "";
  if (/timed out|timeout/i.test(message)) return TEXT.settings.skills.git.inspectTimeout;
  if (/failed to fetch|networkerror|network error|could not reach/i.test(message)) {
    return TEXT.settings.skills.git.inspectNetwork;
  }
  if (/lost its connection|connection reset|early eof|rpc failed|operation too slow|could not read from remote|gnutls|ssl|could not resolve|network is unreachable|connection refused|failed to connect|proxy/i
    .test(message)) {
    return TEXT.settings.skills.git.inspectNetwork;
  }
  if (/checkout failed|internal server error|request failed \(5\d\d\)/i.test(message)) {
    return TEXT.settings.skills.git.checkoutFailed;
  }
  return message || TEXT.settings.skills.importFailed;
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
export function SkillGitImportView({ client, onDone, onStart }: Props) {
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [subdirectory, setSubdirectory] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inspection, setInspection] = useState<GitSkillRepositoryInspection>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<string>();
  const inspectionRequest = useRef<AbortController | undefined>(undefined);

  const reset = () => {
    setInspection(undefined);
    setSelected(new Set());
    setFailure(undefined);
  };

  const inspect = async () => {
    const controller = new AbortController();
    inspectionRequest.current = controller;
    setInspecting(true);
    setInspection(undefined);
    setSelected(new Set());
    setFailure(undefined);
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

  const candidates = inspection?.candidates ?? [];
  const selectable = candidates.filter(
    (candidate) => candidate.status === "new" || candidate.status === "update",
  );
  const allSelected = selectable.length > 0 && selected.size === selectable.length;
  const toggleAll = () => setSelected(allSelected
    ? new Set()
    : new Set(selectable.map((candidate) => candidate.subdirectory)));

  const chosen = candidates.filter((candidate) => selected.has(candidate.subdirectory));
  const total = inspection?.total ?? candidates.length;

  /** Read the next page the server offered. The rows already read stay put,
   *  and new importable rows join the selection only when the user had kept
   *  everything selected: loading more must not re-tick what they unticked. */
  const loadMore = async () => {
    if (!inspection?.nextCursor || loadingMore) return;
    const keepSelecting = selectable.length > 0 && selected.size === selectable.length;
    setLoadingMore(true);
    setFailure(undefined);
    try {
      const more = await inspectGitSkillRepository(client, {
        commit: inspection.commit,
        cursor: inspection.nextCursor,
        ...(inspection.ref ? { ref: inspection.ref } : {}),
        // Re-send what the user typed: a /tree/<ref>/<subdir> URL carries a
        // derived subdirectory that the inspection response does not echo.
        repositoryUrl: url.trim(),
        ...(subdirectory.trim() ? { subdirectory: subdirectory.trim() } : {}),
      });
      setInspection((current) => current
        ? { ...more, candidates: [...current.candidates, ...more.candidates] }
        : more);
      if (keepSelecting) {
        setSelected((current) => {
          const grown = new Set(current);
          for (const candidate of more.candidates) {
            if (candidate.status === "new" || candidate.status === "update") {
              grown.add(candidate.subdirectory);
            }
          }
          return grown;
        });
      }
    } catch (reason) {
      setFailure(messageOf(reason));
    } finally {
      setLoadingMore(false);
    }
  };

  const importFromGit = async () => {
    if (!inspection || chosen.length === 0) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await onStart({
        commit: inspection.commit,
        items: chosen.map((candidate) => ({
          subdirectory: candidate.subdirectory,
          ...(candidate.status === "update" && candidate.currentRevision !== undefined
            ? { expectedRevision: candidate.currentRevision, overwrite: true }
            : {}),
        })),
        ...(inspection.ref ? { ref: inspection.ref } : {}),
        repositoryUrl: inspection.repositoryUrl,
      });
      // The job is accepted and runs in the API; the list is where its
      // progress and the installed packages are shown.
      onDone?.();
    } catch (reason) {
      setFailure(messageOf(reason));
    } finally {
      setBusy(false);
    }
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
        <section
          aria-label={TEXT.settings.skills.git.found(total)}
          className="skill-git-results"
        >
          <div className="skill-git-results-head">
            <div>
              <h3>{TEXT.settings.skills.git.found(total)}</h3>
              <p className="row-note">
                {TEXT.settings.skills.git.commit(inspection.commit)}
                {candidates.length < total
                  ? ` · ${TEXT.settings.skills.git.loaded(candidates.length, total)}`
                  : null}
                {" · "}{TEXT.settings.skills.git.selectHint}
              </p>
            </div>
            <button
              className="primary-button"
              disabled={busy || selected.size === 0}
              onClick={() => void importFromGit()}
              type="button"
            >
              {busy
                ? TEXT.settings.skills.importBusy
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
                {candidates.map((candidate) => {
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
                      </span>
                    </label>
                  );
                })}
              </div>
              {inspection.nextCursor !== undefined ? (
                <div className="skill-git-more">
                  <small className="row-note">
                    {TEXT.settings.skills.git.loaded(candidates.length, total)}
                  </small>
                  <button
                    className="secondary-button"
                    disabled={busy || loadingMore}
                    onClick={() => void loadMore()}
                    type="button"
                  >
                    {loadingMore
                      ? TEXT.settings.skills.git.loadingMore
                      : TEXT.settings.skills.git.loadMore}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}

    </div>
  );
}
