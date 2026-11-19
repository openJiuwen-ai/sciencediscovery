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

import { useEffect, useRef, useState } from "react";

import { ApiRequestError, type ApiClient } from "../../api/client.js";
import {
  getSkill,
  readSkillResource,
  updateSkill,
  updateSkillFile,
} from "../../api/settings.js";
import type { SkillDetail } from "../../api/types.js";
import { TEXT } from "../../text.js";

interface Props {
  client: ApiClient;
  /** The header's back control and the footer's 取消 both leave the page. */
  onCancel?: () => void;
  /** The list behind this view reloads with what was saved. */
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
  onCancel?: () => void;
}

const SKILL_FILE = "SKILL.md";

/** Mirrors `SKILL_LIMITS` in packages/specialist/src/skills.ts; the editor says
 *  what the server will accept rather than letting a save discover it. */
const PACKAGE_LIMITS = {
  files: 500,
  totalBytes: 50 * 1024 * 1024,
} as const;

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

/** Bytes in the package: the SKILL.md the form will write plus its resources.
 *  A reader weighs a package; counting only the files beside SKILL.md would
 *  make a skill whose package is one document read `0 B`. */
function packageBytes(detail: SkillDetail, instructions: string): number {
  const resources = detail.resourceSummary?.bytes ?? 0;
  return resources + new TextEncoder().encode(
    `---\nname: ${detail.name}\ndescription: ${detail.description}\n---\n${instructions}`,
  ).byteLength;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(mb)} MB`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(kb)} KB`;
  return `${bytes} B`;
}

/** A pasted or uploaded SKILL.md, split at its frontmatter block. Only the
 *  scalar keys the form shows are taken; everything else stays in the package
 *  untouched, exactly as an edit that never opened the block would leave it. */
function splitFrontmatter(text: string): {
  body: string;
  compatibility?: string;
  description?: string;
  license?: string;
} {
  if (!text.startsWith("---")) return { body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { body: text };
  const block = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const fields: { compatibility?: string; description?: string; license?: string } = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1]!;
    const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (key === "description") fields.description = value;
    else if (key === "license") fields.license = value;
    else if (key === "compatibility") fields.compatibility = value;
  }
  return { body, ...fields };
}

/**
 * 技能 › 编辑, shown in place of the list rather than over it.
 *
 * SKILL.md is edited as fields rather than raw YAML, and the optional
 * frontmatter keys this form does not show are submitted back unchanged:
 * `SkillCatalog.update` rebuilds the file from the request and deletes what it
 * is not given, which would silently strip a license or metadata block.
 *
 * The page follows the settings editor's shape: the fields the reader comes to
 * change run down one column, 内容 offers one editor and one way to import a
 * file, and everything the reader rarely needs (the package's own frontmatter,
 * the files beside SKILL.md) folds into 高级设置. 取消 and 保存 sit in a footer,
 * because they are the two ways the page ends.
 *
 * Resource files are written as UTF-8 through the same package-file route. The
 * route has no delete, so neither does this editor.
 */
export function SkillEditorView({ client, onCancel, onSaved, skillId }: Props) {
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
        onCancel={onCancel}
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

function EditorBody({
  activePath,
  client,
  detail,
  onActivePath,
  onCancel,
  onNotice,
  onSaved,
}: BodyProps) {
  const readOnly = detail.readOnly;
  const [description, setDescription] = useState(detail.description);
  const [license, setLicense] = useState(frontmatterString(detail, "license"));
  const [compatibility, setCompatibility] = useState(frontmatterString(detail, "compatibility"));
  const [instructions, setInstructions] = useState(detail.instructions);
  const [fileText, setFileText] = useState<string>();
  const [binary, setBinary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [contentMode, setContentMode] = useState<"write" | "upload">("write");
  const [advancedOpen, setAdvancedOpen] = useState(detail.resources.length > 0);
  const contentInput = useRef<HTMLInputElement>(null);
  const referenceInput = useRef<HTMLInputElement>(null);

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

  /** Apply a pasted or uploaded document: frontmatter fills the fields the
   *  form shows, and only the body is edited below. */
  const importContent = (text: string) => {
    const parsed = splitFrontmatter(text);
    if (parsed.description !== undefined) setDescription(parsed.description);
    if (parsed.license !== undefined) setLicense(parsed.license);
    if (parsed.compatibility !== undefined) setCompatibility(parsed.compatibility);
    setInstructions(parsed.body);
    setContentMode("write");
  };

  const uploadContent = async (file: File) => {
    try {
      importContent(await file.text());
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.skills.editor.contentReadFailed);
    }
  };

  const addReferences = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    setFailure(undefined);
    onNotice(undefined);
    try {
      // Each write bumps the revision, so the next write in the same pick must
      // carry the revision the previous one returned.
      let revision = detail.currentRevision;
      let latest = detail;
      for (const file of files) {
        const name = file.name.split(/[\\/]/).pop() ?? file.name;
        latest = await updateSkillFile(client, detail.id, `references/${name}`, {
          content: await file.text(),
          expectedRevision: revision,
        });
        revision = latest.currentRevision;
      }
      onSaved(latest);
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.skills.editor.addReferenceFailed);
    } finally {
      setBusy(false);
    }
  };

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

  const savingSkill = activePath === SKILL_FILE;
  const saveDisabled = savingSkill
    ? busy || readOnly || description.trim() === "" || instructions.trim() === ""
    : busy || readOnly || binary || fileText === undefined;
  const resourceCount = detail.resources.length;
  const usedBytes = packageBytes(detail, instructions);

  return (
    <div className="skill-editor-page">
      <fieldset className="skill-editor-form" disabled={busy}>
        {readOnly ? <p className="row-note">{TEXT.settings.skills.editor.readOnly}</p> : null}

        <label className="settings-field">
          <span className="settings-field-label">{TEXT.settings.skills.editor.name}</span>
          <input className="field-input" disabled readOnly value={detail.name} />
        </label>

        <label className="settings-field">
          <span className="settings-field-label">{TEXT.settings.skills.editor.description}</span>
          <textarea
            aria-label={TEXT.settings.skills.editor.description}
            className="field-textarea skill-editor-description"
            disabled={busy || readOnly}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            value={description}
          />
          <span className="settings-field-hint">{TEXT.settings.skills.editor.descriptionHint}</span>
        </label>

        <section className="skill-editor-content">
          <div className="skill-editor-content-head">
            <div>
              <span className="settings-field-label">{TEXT.settings.skills.editor.content}</span>
              <span className="settings-field-hint">{TEXT.settings.skills.editor.contentHint}</span>
            </div>
            {activePath === SKILL_FILE ? (
              <div aria-label={TEXT.settings.skills.editor.content} className="skill-editor-mode" role="group">
                <button
                  aria-pressed={contentMode === "write"}
                  className={contentMode === "write" ? "is-active" : ""}
                  onClick={() => setContentMode("write")}
                  type="button"
                >
                  {TEXT.settings.skills.editor.write}
                </button>
                <button
                  aria-pressed={contentMode === "upload"}
                  className={contentMode === "upload" ? "is-active" : ""}
                  onClick={() => setContentMode("upload")}
                  type="button"
                >
                  {TEXT.settings.skills.editor.upload}
                </button>
              </div>
            ) : null}
          </div>

          {activePath === SKILL_FILE ? (
            contentMode === "write" ? (
              <>
                <textarea
                  aria-label={TEXT.settings.skills.editor.instructions}
                  className="field-textarea skill-editor-body"
                  disabled={busy || readOnly}
                  onChange={(event) => setInstructions(event.target.value)}
                  onPaste={(event) => {
                    const pasted = event.clipboardData.getData("text/plain");
                    if (!pasted.startsWith("---")) return;
                    // Only a paste that is the whole document opts into
                    // frontmatter semantics; pasting a block into the middle
                    // of the body must not rewrite the fields above.
                    const replacesAll = instructions.length === 0
                      || (event.currentTarget.selectionStart === 0
                        && event.currentTarget.selectionEnd === instructions.length);
                    if (!replacesAll) return;
                    event.preventDefault();
                    importContent(pasted);
                  }}
                  rows={16}
                  spellCheck={false}
                  value={instructions}
                />
                <span className="settings-field-hint">{TEXT.settings.skills.editor.pasteHint}</span>
              </>
            ) : (
              <button
                className="skill-editor-drop"
                onClick={() => contentInput.current?.click()}
                type="button"
              >
                <svg aria-hidden="true" fill="none" height="22" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="22">
                  <path d="M12 15V4m-4 4 4-4 4 4M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" />
                </svg>
                <span className="skill-editor-drop-title">{TEXT.settings.skills.editor.uploadTitle}</span>
                <span className="skill-editor-drop-hint">{TEXT.settings.skills.editor.uploadHint}</span>
              </button>
            )
          ) : (
            <label className="settings-field">
              <span className="settings-field-label">{activePath}</span>
              {binary ? (
                <p className="row-note">{TEXT.settings.skills.editor.binary}</p>
              ) : (
                <textarea
                  aria-label={activePath}
                  className="field-textarea skill-editor-body"
                  disabled={busy || readOnly || fileText === undefined}
                  onChange={(event) => setFileText(event.target.value)}
                  rows={16}
                  spellCheck={false}
                  value={fileText ?? ""}
                />
              )}
            </label>
          )}

          <input
            accept=".md,.markdown,.txt,text/*"
            aria-label={TEXT.settings.skills.editor.upload}
            className="skill-editor-hidden-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void uploadContent(file);
            }}
            ref={contentInput}
            tabIndex={-1}
            type="file"
          />
        </section>

        <div className="skill-editor-advanced">
          <button
            aria-controls="skill-advanced-settings"
            aria-expanded={advancedOpen}
            className="skill-editor-advanced-toggle"
            onClick={() => setAdvancedOpen((open) => !open)}
            type="button"
          >
            <svg
              aria-hidden="true"
              className={advancedOpen ? "skill-editor-chev" : "skill-editor-chev is-closed"}
              fill="none"
              height="14"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
              width="14"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
            {TEXT.settings.skills.editor.advanced}
          </button>

          {advancedOpen ? (
            <section className="skill-editor-advanced-body" id="skill-advanced-settings">
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

              <div className="skill-editor-references-head">
                <div>
                  <span className="settings-field-label">{TEXT.settings.skills.editor.references}</span>
                  <span className="settings-field-hint">{TEXT.settings.skills.editor.referencesHint}</span>
                </div>
              </div>
              <span className="skill-editor-usage">
                {TEXT.settings.skills.editor.referencesUsage(
                  resourceCount,
                  PACKAGE_LIMITS.files - 1,
                  formatBytes(usedBytes),
                  formatBytes(PACKAGE_LIMITS.totalBytes),
                )}
              </span>

              <button
                className="skill-editor-drop is-reference"
                disabled={busy || readOnly}
                onClick={() => referenceInput.current?.click()}
                type="button"
              >
                <svg aria-hidden="true" fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="20">
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <path d="M14 3v5h5M12 12v5m-2.5-2.5L12 17l2.5-2.5" />
                </svg>
                <span className="skill-editor-drop-title">{TEXT.settings.skills.editor.referencesDrop}</span>
                <span className="skill-editor-drop-hint">{TEXT.settings.skills.editor.referencesDropHint}</span>
              </button>
              <input
                aria-label={TEXT.settings.skills.editor.references}
                className="skill-editor-hidden-input"
                multiple
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  void addReferences(files);
                }}
                ref={referenceInput}
                tabIndex={-1}
                type="file"
              />

              {resourceCount > 0 ? (
                <ul className="skill-editor-resources">
                  {detail.resources.map((resource) => (
                    <li key={resource.path}>
                      <button
                        aria-label={resource.path}
                        aria-pressed={activePath === resource.path}
                        className={`skill-editor-resource${activePath === resource.path ? " is-active" : ""}`}
                        onClick={() => onActivePath(resource.path)}
                        type="button"
                      >
                        <span className="skill-editor-resource-path">{resource.path}</span>
                        <span className="skill-editor-resource-size">{formatBytes(resource.size)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>

        {failure ? <small className="row-note is-error" role="alert">{failure}</small> : null}
      </fieldset>

      <footer className="skill-editor-footer">
        <button
          className="secondary-button skill-editor-cancel"
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          {TEXT.settings.skills.editor.cancel}
        </button>
        <button
          className="pill-button is-dark"
          disabled={saveDisabled}
          onClick={() => void (savingSkill ? saveSkill() : saveResource())}
          type="button"
        >
          {busy ? TEXT.settings.skills.editor.saving : TEXT.settings.skills.editor.save}
        </button>
      </footer>
    </div>
  );
}
