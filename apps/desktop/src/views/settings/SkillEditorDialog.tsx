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

import { ApiRequestError, type ApiClient } from "../../api/client.js";
import {
  getSkill,
  readSkillResource,
  updateSkill,
  updateSkillFile,
} from "../../api/settings.js";
import type { SkillDetail } from "../../api/types.js";
import { TEXT } from "../../text.js";

interface DialogProps {
  client: ApiClient;
  onClose: () => void;
  /** The list behind the modal reloads with what was installed. */
  onSaved: (skill: SkillDetail) => void;
  skillId: string;
}

interface BodyProps {
  activePath: string;
  client: ApiClient;
  detail: SkillDetail;
  onActivePath: (path: string) => void;
  /** The save notice lives above the body: a successful save re-keys it with
   *  the new revision, and anything it held itself would be gone by then. */
  onNotice: (message: string | undefined) => void;
  onSaved: (skill: SkillDetail) => void;
}

const SKILL_FILE = "SKILL.md";

function messageOf(reason: unknown): string {
  if (reason instanceof ApiRequestError && reason.status === 409) {
    return TEXT.settings.skills.editor.conflict;
  }
  return reason instanceof Error ? reason.message : TEXT.settings.skills.editor.loadFailed;
}

function frontmatterString(detail: SkillDetail, key: string): string {
  const value = detail.frontmatter[key];
  return typeof value === "string" ? value : "";
}

function frontmatterMetadata(detail: SkillDetail): Record<string, unknown> | undefined {
  const value = detail.frontmatter.metadata;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * The editor behind a managed Skill's 编辑.
 *
 * SKILL.md is edited as fields rather than raw YAML, and the four optional
 * frontmatter keys this form does not show are submitted back unchanged:
 * `SkillCatalog.update` rebuilds the file from the request and deletes what it
 * is not given, which would silently strip a license or metadata block.
 *
 * Resource files are written as UTF-8 through the same package-file route. The
 * route has no delete, so neither does this editor.
 */
export function SkillEditorDialog({ client, onClose, onSaved, skillId }: DialogProps) {
  const [detail, setDetail] = useState<SkillDetail>();
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [activePath, setActivePath] = useState(SKILL_FILE);

  useEffect(() => {
    let cancelled = false;
    getSkill(client, skillId).then(
      (found) => { if (!cancelled) setDetail(found); },
      (reason: unknown) => { if (!cancelled) setFailure(messageOf(reason)); },
    );
    return () => { cancelled = true; };
  }, [client, skillId]);

  useEffect(() => {
    if (activePath !== SKILL_FILE && detail
      && !detail.resources.some((resource) => resource.path === activePath)) {
      setActivePath(SKILL_FILE);
    }
  }, [activePath, detail]);

  if (failure && !detail) {
    return <small className="row-note is-error" role="alert">{failure}</small>;
  }
  if (!detail) {
    return <p className="row-note">{TEXT.settings.skills.instructionsLoading}</p>;
  }

  return (
    <>
      <EditorBody
        activePath={activePath}
        client={client}
        detail={detail}
        key={`${detail.id}:${detail.currentRevision}`}
        onActivePath={setActivePath}
        onCancel={onClose}
        onNotice={setNotice}
        onSaved={(next) => {
          setNotice(TEXT.settings.skills.editor.saved);
          setFailure(undefined);
          setDetail(next);
          onSaved(next);
        }}
      />
      {notice ? <small className="row-note" role="status">{notice}</small> : null}
    </>
  );
}

function EditorBody({ activePath, client, detail, onActivePath, onNotice, onSaved, onCancel }: BodyProps & { onCancel: () => void }) {
  const readOnly = detail.readOnly;
  const [description, setDescription] = useState(detail.description);
  const [license, setLicense] = useState(frontmatterString(detail, "license"));
  const [compatibility, setCompatibility] = useState(frontmatterString(detail, "compatibility"));
  const [instructions, setInstructions] = useState(detail.instructions);
  const [fileText, setFileText] = useState<string>();
  const [binary, setBinary] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [newContent, setNewContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (activePath === SKILL_FILE) return;
    let cancelled = false;
    setFileText(undefined);
    setBinary(false);
    readSkillResource(client, detail.id, activePath).then(
      (content) => { if (!cancelled) setFileText(content.content); },
      (reason: unknown) => {
        if (cancelled) return;
        // A binary file is not a failed read: the pane says it cannot be
        // edited here, which is the whole of what went wrong.
        const notText = reason instanceof Error && /not valid UTF-8/.test(reason.message);
        setBinary(notText);
        setFailure(notText ? undefined : messageOf(reason));
      },
    );
    return () => { cancelled = true; };
  }, [activePath, client, detail.id]);

  const saveSkill = async () => {
    setBusy(true);
    setFailure(undefined);
    onNotice(undefined);
    try {
      const metadata = frontmatterMetadata(detail);
      const allowedTools = frontmatterString(detail, "allowed-tools");
      const trimmedLicense = license.trim();
      const trimmedCompatibility = compatibility.trim();
      onSaved(await updateSkill(client, detail.id, {
        description: description.trim(),
        expectedRevision: detail.currentRevision,
        instructions,
        name: detail.name,
        ...(trimmedCompatibility ? { compatibility: trimmedCompatibility } : {}),
        ...(trimmedLicense ? { license: trimmedLicense } : {}),
        ...(metadata ? { metadata } : {}),
        ...(allowedTools ? { allowedTools } : {}),
      }));
    } catch (reason) {
      setFailure(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveResource = async () => {
    if (fileText === undefined) return;
    setBusy(true);
    setFailure(undefined);
    onNotice(undefined);
    try {
      onSaved(await updateSkillFile(client, detail.id, activePath, {
        content: fileText,
        expectedRevision: detail.currentRevision,
      }));
    } catch (reason) {
      setFailure(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  const addFile = async () => {
    const path = newPath.trim();
    if (path === "" || path === SKILL_FILE) return;
    setBusy(true);
    setFailure(undefined);
    onNotice(undefined);
    try {
      const next = await updateSkillFile(client, detail.id, path, {
        content: newContent,
        expectedRevision: detail.currentRevision,
      });
      onActivePath(path);
      setNewPath("");
      setNewContent("");
      onSaved(next);
    } catch (reason) {
      setFailure(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  const newPathValid = newPath.trim() !== "" && newPath.trim() !== SKILL_FILE;

  return (
    <div className="skill-editor">
      <aside className="skill-editor-files">
        <span className="settings-field-label">{TEXT.settings.skills.editor.files}</span>
        <button
          aria-pressed={activePath === SKILL_FILE}
          className={`skill-editor-file${activePath === SKILL_FILE ? " is-active" : ""}`}
          onClick={() => onActivePath(SKILL_FILE)}
          type="button"
        >
          {TEXT.settings.skills.editor.skillFile}
        </button>
        {detail.resources.map((resource) => (
          <button
            aria-pressed={activePath === resource.path}
            className={`skill-editor-file${activePath === resource.path ? " is-active" : ""}`}
            key={resource.path}
            onClick={() => onActivePath(resource.path)}
            type="button"
          >
            {resource.path}
          </button>
        ))}
        <p className="row-note">{TEXT.settings.skills.editor.resourcesHint}</p>
      </aside>

      <div className="skill-editor-pane">
        {readOnly ? <p className="row-note">{TEXT.settings.skills.editor.readOnly}</p> : null}
        {activePath === SKILL_FILE ? (
          <>
            <label className="settings-field">
              <span className="settings-field-label">{TEXT.settings.skills.editor.name}</span>
              <input className="field-input" disabled readOnly value={detail.name} />
            </label>
            <label className="settings-field">
              <span className="settings-field-label">{TEXT.settings.skills.editor.description}</span>
              <textarea
                aria-label={TEXT.settings.skills.editor.description}
                className="field-textarea"
                disabled={busy || readOnly}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                value={description}
              />
            </label>
            <div className="settings-field-pair">
              <label className="settings-field">
                <span className="settings-field-label">{TEXT.settings.skills.editor.license}</span>
                <input
                  className="field-input"
                  disabled={busy || readOnly}
                  onChange={(event) => setLicense(event.target.value)}
                  value={license}
                />
              </label>
              <label className="settings-field">
                <span className="settings-field-label">{TEXT.settings.skills.editor.compatibility}</span>
                <input
                  className="field-input"
                  disabled={busy || readOnly}
                  onChange={(event) => setCompatibility(event.target.value)}
                  value={compatibility}
                />
              </label>
            </div>
            <label className="settings-field">
              <span className="settings-field-label">{TEXT.settings.skills.editor.instructions}</span>
              <textarea
                aria-label={TEXT.settings.skills.editor.instructions}
                className="field-textarea is-tall"
                disabled={busy || readOnly}
                onChange={(event) => setInstructions(event.target.value)}
                rows={14}
                value={instructions}
              />
            </label>
            <div className="settings-card-actions">
              <button className="secondary-button" onClick={onCancel} type="button">
                {TEXT.settings.cancel}
              </button>
              <button
                className="primary-button"
                disabled={busy || readOnly || description.trim() === "" || instructions.trim() === ""}
                onClick={() => void saveSkill()}
                type="button"
              >
                {busy ? TEXT.settings.skills.editor.saving : TEXT.settings.skills.editor.save}
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="settings-field">
              <span className="settings-field-label">{activePath}</span>
              {binary ? (
                <p className="row-note">{TEXT.settings.skills.editor.binary}</p>
              ) : (
                <textarea
                  aria-label={activePath}
                  className="field-textarea is-tall"
                  disabled={busy || readOnly || fileText === undefined}
                  onChange={(event) => setFileText(event.target.value)}
                  rows={16}
                  value={fileText ?? ""}
                />
              )}
            </label>
            <div className="settings-card-actions">
              <button className="secondary-button" onClick={onCancel} type="button">
                {TEXT.settings.cancel}
              </button>
              <button
                className="primary-button"
                disabled={busy || readOnly || binary || fileText === undefined}
                onClick={() => void saveResource()}
                type="button"
              >
                {busy ? TEXT.settings.skills.editor.saving : TEXT.settings.skills.editor.save}
              </button>
            </div>
          </>
        )}

        <div className="settings-field">
          <span className="settings-field-label">{TEXT.settings.skills.editor.newFile}</span>
          <div className="skill-editor-new-file">
            <input
              aria-label={TEXT.settings.skills.editor.newFilePath}
              className="field-input"
              disabled={busy || readOnly}
              onChange={(event) => setNewPath(event.target.value)}
              placeholder={TEXT.settings.skills.editor.newFilePathPlaceholder}
              spellCheck={false}
              value={newPath}
            />
            <button
              className="secondary-button"
              disabled={busy || readOnly || !newPathValid}
              onClick={() => void addFile()}
              type="button"
            >
              {TEXT.settings.skills.editor.addFile}
            </button>
          </div>
          <textarea
            aria-label={TEXT.settings.skills.editor.newFile}
            className="field-textarea"
            disabled={busy || readOnly}
            onChange={(event) => setNewContent(event.target.value)}
            rows={4}
            value={newContent}
          />
        </div>

        {failure ? <small className="row-note is-error" role="alert">{failure}</small> : null}
      </div>
    </div>
  );
}
