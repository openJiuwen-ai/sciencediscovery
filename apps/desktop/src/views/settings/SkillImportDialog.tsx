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
import {
  importSkillFile,
  importSkillFromGit,
  inspectGitSkillRepository,
} from "../../api/settings.js";
import type {
  GitSkillImportCandidate,
  GitSkillRepositoryInspection,
  SkillDetail,
} from "../../api/types.js";
import { TEXT } from "../../text.js";

type Tab = "file" | "git" | "zip";

interface Props {
  client: ApiClient;
  /** Run for every package the server installs; the caller enables it and
   *  reloads the list behind the modal. */
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
 * 技能 › 导入技能.
 *
 * A single SKILL.md and a ZIP take the multipart route; Git takes the
 * inspect-then-select route, because a repository may hold several packages
 * and only the user can say which ones belong in this catalog. Inspection pins
 * the commit, and every selected package is imported at that exact commit.
 */
export function SkillImportDialog({ client, onImported }: Props) {
  const [tab, setTab] = useState<Tab>("file");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [subdirectory, setSubdirectory] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState<GitSkillRepositoryInspection>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const chooseTab = (next: Tab) => {
    setTab(next);
    // The two upload tabs read the same `file`; carrying a SKILL.md into the ZIP
    // tab (or a ZIP into the file tab) is a package the user did not choose.
    setFile(undefined);
    setFailure(undefined);
    setNotice(undefined);
  };

  const importSelectedFile = async () => {
    if (!file) return;
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

  const inspect = async () => {
    setInspecting(true);
    setFailure(undefined);
    setNotice(undefined);
    setInspection(undefined);
    setRowErrors({});
    try {
      const inspection = await inspectGitSkillRepository(client, {
        repositoryUrl: url.trim(),
        ...(ref.trim() ? { ref: ref.trim() } : {}),
        ...(subdirectory.trim() ? { subdirectory: subdirectory.trim() } : {}),
      });
      setInspection(inspection);
      setSelected(new Set(inspection.candidates
        .filter((candidate) => candidate.status === "new" || candidate.status === "update")
        .map((candidate) => candidate.subdirectory)));
    } catch (reason) {
      setFailure(messageOf(reason));
    } finally {
      setInspecting(false);
    }
  };

  const toggle = (subdirectory: string, next: boolean) => {
    setSelected((current) => {
      const copy = new Set(current);
      if (next) copy.add(subdirectory);
      else copy.delete(subdirectory);
      return copy;
    });
  };

  const chosen = inspection?.candidates.filter((candidate) => selected.has(candidate.subdirectory)) ?? [];

  const importFromGit = async () => {
    if (!inspection || chosen.length === 0) return;
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    const errors: Record<string, string> = {};
    let imported = 0;
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
    }
    setRowErrors(errors);
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
    <div className="settings-card is-form skill-import">
      <div className="skill-import-tabs" role="tablist">
        {(["file", "zip", "git"] as const).map((value) => (
          <button
            aria-selected={tab === value}
            className={`skill-import-tab${tab === value ? " is-active" : ""}`}
            disabled={busy}
            key={value}
            onClick={() => chooseTab(value)}
            role="tab"
            type="button"
          >
            {TEXT.settings.skills.importTabs[value]}
          </button>
        ))}
      </div>

      {tab === "file" || tab === "zip" ? (
        <div className="settings-card-form">
          <p className="row-note">
            {tab === "file" ? TEXT.settings.skills.importFileHint : TEXT.settings.skills.importZipHint}
          </p>
          <label className="settings-field">
            <span className="settings-field-label">{TEXT.settings.skills.importChoose}</span>
            <input
              accept={tab === "file" ? ".md,text/markdown" : ".zip,application/zip"}
              className="field-input"
              disabled={busy}
              key={tab}
              onChange={(event) => {
                setFile(event.target.files?.[0]);
                setFailure(undefined);
                setNotice(undefined);
              }}
              type="file"
            />
          </label>
          <p className="row-note">{file?.name ?? TEXT.settings.skills.importNoFile}</p>
          <div className="settings-card-actions">
            <button
              className="primary-button"
              disabled={busy || !file}
              onClick={() => void importSelectedFile()}
              type="button"
            >
              {busy ? TEXT.settings.skills.importBusy : TEXT.settings.skills.importAction}
            </button>
          </div>
        </div>
      ) : (
        <div className="settings-card-form">
          <label className="settings-field">
            <span className="settings-field-label">{TEXT.settings.skills.git.url}</span>
            <input
              aria-label={TEXT.settings.skills.git.url}
              className="field-input"
              disabled={inspecting || busy}
              onChange={(event) => {
                setUrl(event.target.value);
                setInspection(undefined);
                setSelected(new Set());
                setRowErrors({});
              }}
              placeholder={TEXT.settings.skills.git.urlPlaceholder}
              spellCheck={false}
              value={url}
            />
          </label>
          <div className="settings-field-pair">
            <label className="settings-field">
              <span className="settings-field-label">{TEXT.settings.skills.git.ref}</span>
              <input
                aria-label={TEXT.settings.skills.git.ref}
                className="field-input"
                disabled={inspecting || busy}
                onChange={(event) => setRef(event.target.value)}
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
                onChange={(event) => setSubdirectory(event.target.value)}
                placeholder={TEXT.settings.skills.git.subdirectoryPlaceholder}
                spellCheck={false}
                value={subdirectory}
              />
            </label>
          </div>
          <div className="settings-card-actions">
            <button
              className="secondary-button"
              disabled={inspecting || busy || url.trim() === ""}
              onClick={() => void inspect()}
              type="button"
            >
              {inspecting ? TEXT.settings.skills.git.inspecting : TEXT.settings.skills.git.inspect}
            </button>
          </div>

          {inspection ? (
            <div className="skill-candidates">
              <p className="row-note">
                {TEXT.settings.skills.git.commit(inspection.commit)} · {TEXT.settings.skills.git.selectHint}
              </p>
              {inspection.candidates.length === 0 ? (
                <p className="settings-empty">{TEXT.settings.skills.git.empty}</p>
              ) : null}
              {inspection.candidates.map((candidate) => {
                const selectable = candidate.status === "new" || candidate.status === "update";
                return (
                  <label
                    className={`skill-candidate${selectable ? "" : " is-disabled"}`}
                    key={candidate.subdirectory}
                  >
                    <input
                      checked={selected.has(candidate.subdirectory)}
                      disabled={!selectable || busy}
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
              <div className="settings-card-actions">
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
            </div>
          ) : null}
        </div>
      )}

      {failure ? <small className="row-note is-error" role="alert">{failure}</small> : null}
      {notice ? <small className="row-note" role="status">{notice}</small> : null}
    </div>
  );
}
