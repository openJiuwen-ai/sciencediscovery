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
  GitSkillImportJob,
  GitSkillRepositoryInspection,
  StartGitSkillImportJobRequest,
} from "../../api/types.js";
import { TEXT } from "../../text.js";

interface Props {
  client: ApiClient;
  /** The background job this dialog started, once the store has it. The dialog
   *  stays open on its progress and the list takes over when it ends. */
  job?: GitSkillImportJob;
  /** Closes the dialog without importing. */
  onCancel: () => void;
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

/** An http(s) repository address: a host and at least an owner/repository
 *  path. The handoff draws a GitHub URL, and that is the common case, but the
 *  route itself clones any https remote, so the check only refuses what cannot
 *  be a repository before a clone is attempted. */
function looksLikeRepositoryUrl(value: string): boolean {
  return /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+/iu.test(value.trim());
}

function GitHubMark() {
  return (
    <svg aria-hidden="true" className="skill-git-github" height="32" viewBox="0 0 16 16" width="32">
      <path
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * 技能 › 从 GitHub 导入, as the handoff's dialog.
 *
 * Inspection comes before any write, because a repository may hold several
 * packages and only the user can say which ones belong in this catalog. The
 * inspection pins a commit and every selected package is imported at that
 * exact commit, so the rows the user ticked are the bytes that get installed.
 *
 * The import itself is one background job: the dialog shows its progress
 * (`done / total`) and closes when it ends, leaving the list and its banner to
 * report the outcome.
 */
export function SkillGitImportView({ client, job, onCancel, onStart }: Props) {
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [subdirectory, setSubdirectory] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inspection, setInspection] = useState<GitSkillRepositoryInspection>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<string>();
  /** Why the rows that were on screen are gone. A neutral line rather than an
   *  error: editing the repository is a normal thing to do, and the only thing
   *  wrong with it is that the rows no longer describe the fields. */
  const [note, setNote] = useState<string>();
  const inspectionRequest = useRef<AbortController | undefined>(undefined);
  const paginationRequest = useRef<AbortController | undefined>(undefined);
  /** Bumped by every source edit, every new inspection and a cancelled one.
   *  A response that started under an older value belongs to results the user
   *  has already replaced: it must neither paint, nor re-tick, nor be
   *  imported under the repository the fields now name. */
  const generation = useRef(0);
  /** The source the results on screen were read from. Import may only submit
   *  what the user is looking at. */
  const inspectionSource = useRef<{ ref: string; subdirectory: string; url: string } | undefined>(undefined);
  // The source the fields hold right now, read by the import guard below.
  const source = { ref: ref.trim(), subdirectory: subdirectory.trim(), url: url.trim() };

  /** Take ownership of the results away from anything still in flight. */
  const invalidate = () => {
    generation.current += 1;
    paginationRequest.current?.abort();
    paginationRequest.current = undefined;
  };

  /** Drop the rows and everything that belonged to them. `explain` is what the
   *  reader is told about the rows that just disappeared. */
  const reset = (explain?: string) => {
    invalidate();
    setInspection(undefined);
    setSelected(new Set());
    setFailure(undefined);
    setNote(explain);
  };

  /** A field edit is a new source. The rows read from the old one cannot
   *  survive it, and saying why is the difference between a result the reader
   *  moved on from and one that vanished.
   *
   *  The decision reads the note as well as the rows: the first keystroke has
   *  already dropped the inspection by the time this runs, so keying off the
   *  rows alone would explain the loss once and then go quiet while the reader
   *  is still typing the new address. */
  const editSource = (apply: () => void) => {
    const hadRows = inspection !== undefined || note !== undefined;
    apply();
    reset(hadRows ? TEXT.settings.skills.gitDialog.sourceChanged : undefined);
  };

  const inspect = async () => {
    if (!looksLikeRepositoryUrl(url)) {
      reset();
      setFailure(TEXT.settings.skills.gitDialog.invalidUrl);
      return;
    }
    const requested = { ...source };
    invalidate();
    const token = generation.current;
    const controller = new AbortController();
    inspectionRequest.current = controller;
    setInspecting(true);
    setInspection(undefined);
    setSelected(new Set());
    setFailure(undefined);
    setNote(undefined);
    try {
      const found = await inspectGitSkillRepository(client, {
        repositoryUrl: requested.url,
        ...(requested.ref ? { ref: requested.ref } : {}),
        ...(requested.subdirectory ? { subdirectory: requested.subdirectory } : {}),
      }, controller.signal);
      // A source edit or a cancel while the clone ran owns the dialog now; this
      // answer is about a repository the fields no longer name.
      if (generation.current !== token) return;
      inspectionSource.current = requested;
      setInspection(found);
      // Everything that can be written is ticked: the usual import is "all of
      // it", and the user unticks rather than ticks.
      setSelected(new Set(found.candidates
        .filter((candidate) => candidate.status === "new" || candidate.status === "update")
        .map((candidate) => candidate.subdirectory)));
    } catch (reason) {
      if (generation.current !== token) return;
      // A cancelled inspection is not a failure: the user said stop.
      if (!isAbortError(reason)) setFailure(messageOf(reason));
    } finally {
      if (inspectionRequest.current === controller) {
        inspectionRequest.current = undefined;
        setInspecting(false);
      }
    }
  };

  /** Stop waiting for the clone. The server finishes its own work; what this
   *  ends is the dialog being unusable while it does. */
  const cancelInspect = () => {
    invalidate();
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
    const reading = inspection;
    if (!reading?.nextCursor || loadingMore) return;
    const token = generation.current;
    const keepSelecting = selectable.length > 0 && selected.size === selectable.length;
    const controller = new AbortController();
    paginationRequest.current = controller;
    setLoadingMore(true);
    setFailure(undefined);
    try {
      const more = await inspectGitSkillRepository(client, {
        commit: reading.commit,
        cursor: reading.nextCursor,
        ...(reading.ref ? { ref: reading.ref } : {}),
        // Re-send what the user typed: a /tree/<ref>/<subdir> URL carries a
        // derived subdirectory that the inspection response does not echo.
        repositoryUrl: source.url,
        ...(source.subdirectory ? { subdirectory: source.subdirectory } : {}),
      }, controller.signal);
      // The fields or the inspection moved on while this page was on the way.
      // Its rows belong to a repository or commit the dialog no longer shows, so
      // they must not come back as selectable rows under the new source.
      if (generation.current !== token) return;
      if (more.repositoryUrl !== reading.repositoryUrl || more.commit !== reading.commit) return;
      setInspection((current) => current !== undefined
        && current.commit === more.commit
        && current.repositoryUrl === more.repositoryUrl
        ? { ...more, candidates: [...current.candidates, ...more.candidates] }
        : current);
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
      if (generation.current === token && !isAbortError(reason)) setFailure(messageOf(reason));
    } finally {
      if (paginationRequest.current === controller) paginationRequest.current = undefined;
      setLoadingMore(false);
    }
  };

  const importFromGit = async () => {
    if (!inspection || chosen.length === 0) return;
    const inspected = inspectionSource.current;
    if (inspected === undefined
      || inspected.url !== source.url
      || inspected.ref !== source.ref
      || inspected.subdirectory !== source.subdirectory) {
      // The rows on screen were read from a source the fields no longer name;
      // importing them would install another repository than the one shown.
      reset();
      setFailure(TEXT.settings.skills.gitDialog.sourceChanged);
      return;
    }
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
    } catch (reason) {
      setFailure(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  const active = job !== undefined && (job.status === "queued" || job.status === "running") ? job : undefined;
  const percent = active !== undefined && active.total > 0 ? Math.round((active.done / active.total) * 100) : 0;

  return (
    <div className="skill-git">
      <div className="skill-git-intro">
        <div aria-hidden="true" className="skill-git-marks">
          <GitHubMark />
          <span className="skill-git-dots"><i /><i /><i /></span>
          <span className="skill-git-app-mark" />
        </div>
        <p className="skill-git-subtitle">{TEXT.settings.skills.gitDialog.subtitle}</p>
      </div>

      {active !== undefined ? (
        <div className="skill-git-progress-block" role="status">
          <p className="skill-git-progress-text">
            {TEXT.settings.skills.gitDialog.progress(active.done, active.total)}
          </p>
          <div className="skill-git-progress-row">
            <div
              aria-hidden="true"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={percent}
              className="skill-git-progress-bar"
              role="progressbar"
            >
              <span style={{ width: `${percent}%` }} />
            </div>
            <span className="skill-git-progress-pct">{percent}%</span>
          </div>
        </div>
      ) : (
        <>
          <div className="skill-git-field">
            <label className="settings-field">
              <span className="settings-field-label">{TEXT.settings.skills.git.url}</span>
              <div className="skill-git-url-row">
                <input
                  aria-label={TEXT.settings.skills.git.url}
                  className={`field-input${failure ? " is-error" : ""}`}
                  disabled={inspecting || busy}
                  onChange={(event) => {
                    editSource(() => setUrl(event.target.value));
                  }}
                  placeholder={TEXT.settings.skills.git.urlPlaceholder}
                  spellCheck={false}
                  value={url}
                />
                <button
                  className="secondary-button"
                  disabled={inspecting || busy || url.trim() === ""}
                  onClick={() => void inspect()}
                  type="button"
                >
                  {inspecting ? TEXT.settings.skills.git.inspecting : TEXT.settings.skills.git.inspect}
                </button>
              </div>
            </label>
          </div>

          {failure ? <small className="row-note is-error" role="alert">{failure}</small> : null}
          {note ? <small className="row-note skill-git-note" role="status">{note}</small> : null}

          <details className="skill-git-advanced">
            <summary>{TEXT.settings.skills.gitDialog.advanced}</summary>
            <div className="settings-field-pair">
              <label className="settings-field">
                <span className="settings-field-label">{TEXT.settings.skills.git.ref}</span>
                <input
                  aria-label={TEXT.settings.skills.git.ref}
                  className="field-input"
                  disabled={inspecting || busy}
                  onChange={(event) => {
                    editSource(() => setRef(event.target.value));
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
                    editSource(() => setSubdirectory(event.target.value));
                  }}
                  placeholder={TEXT.settings.skills.git.subdirectoryPlaceholder}
                  spellCheck={false}
                  value={subdirectory}
                />
              </label>
            </div>
          </details>

          {inspecting ? (
            <div className="skill-git-progress" role="status">
              <small className="row-note">{TEXT.settings.skills.git.inspectHint}</small>
              <button className="secondary-button" onClick={cancelInspect} type="button">
                {TEXT.settings.skills.git.cancelInspect}
              </button>
            </div>
          ) : null}

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

              {candidates.length === 0 ? (
                <p className="settings-empty">{TEXT.settings.skills.git.empty}</p>
              ) : (
                <>
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
        </>
      )}

      <div className="skill-dialog-actions">
        <button
          className="secondary-button"
          disabled={busy || active !== undefined}
          onClick={onCancel}
          type="button"
        >
          {TEXT.settings.skills.uploadDialog.cancel}
        </button>
        <button
          className="primary-button"
          disabled={busy || active !== undefined || !inspection || chosen.length === 0}
          onClick={() => void importFromGit()}
          type="button"
        >
          {busy || active !== undefined
            ? TEXT.settings.skills.gitDialog.importing
            : inspection === undefined
              ? TEXT.settings.skills.importAction
              : TEXT.settings.skills.git.importSelected(chosen.length)}
        </button>
      </div>
    </div>
  );
}
