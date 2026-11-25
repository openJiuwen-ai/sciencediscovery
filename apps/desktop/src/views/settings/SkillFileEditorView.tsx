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

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { ApiClient } from "../../api/client.js";
import {
  deleteSkillFile,
  getSkill,
  getSkillMarkdown,
  readSkillResource,
  renameSkillFile,
  updateSkillFile,
  updateSkillMarkdown,
} from "../../api/settings.js";
import type { SkillDetail } from "../../api/types.js";
import { TEXT } from "../../text.js";
import { SkillConfirmDialog } from "./SkillConfirmDialog.js";
import { fileTree, packagePaths, type TreeNode } from "./skill-files.js";
import { markTone } from "./skill-tone.js";
import { CaretGlyph, NodeGlyph } from "./skill-tree-glyphs.js";

const SKILL_MD = "SKILL.md";
const TEXT_FILE = /\.(md|markdown|txt|json|ya?ml|csv|tsv|js|mjs|cjs|ts|py|sh|bash|html?|css|xml|toml|ini|cfg|conf)$/iu;

interface Props {
  client: ApiClient;
  /** Leaves edit mode; the caller decides where to go. */
  onCancel: () => void;
  /** A save changed the package; the list behind reloads. */
  onSaved: (skill: SkillDetail) => void;
  skillId: string;
}

/** A path that can identify a file in the package, or undefined. */
function validPath(value: string): string | undefined {
  const path = value.trim().replace(/\\/gu, "/");
  if (path === "" || path.startsWith("/")) return undefined;
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
  return path;
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : TEXT.settings.skills.editor.saveFailed;
}

const ICON = {
  "aria-hidden": true as const,
  fill: "none",
  height: 16,
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  strokeWidth: 1.6,
  viewBox: "0 0 24 24",
  width: 16,
};

const FolderAddGlyph = () => (
  <svg {...ICON}>
    <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    <path d="M12 11v5m-2.5-2.5h5" />
  </svg>
);

const FileAddGlyph = () => (
  <svg {...ICON}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5M12 11v6m-3-3h6" />
  </svg>
);

const UploadGlyph = () => (
  <svg {...ICON}>
    <path d="M12 15V4m-4 4 4-4 4 4M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" />
  </svg>
);

const EditGlyph = () => (
  <svg {...ICON}>
    <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    <path d="m17.4 3.6 2.9 2.9-7.1 7.1-3.5.7.7-3.5z" />
  </svg>
);

const DeleteGlyph = () => (
  <svg {...ICON}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0-1 12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 7" />
    <path d="M10 11v5m4-5v5" />
  </svg>
);

const CheckGlyph = () => (
  <svg {...ICON} strokeWidth={2}>
    <path d="m5 12 4.5 4.5L19 7" />
  </svg>
);

type Creating = { kind: "file" | "folder"; /** Folder a new file lands in; "" is the package root. */ parent: string; value: string };
type Renaming = { base: string; value: string };

/**
 * 技能 › edit, as the handoff draws 2-3.
 *
 * The package is edited where it is read: the tree on the left gains 新建文件夹,
 * 新建文件 and 上传, each row offers rename and delete on hover, and the file
 * opens as its own raw text — frontmatter included for SKILL.md. Every write
 * carries the revision the editor read, so a package changed elsewhere is a
 * conflict rather than a silent overwrite.
 */
export function SkillFileEditorView({ client, onCancel, onSaved, skillId }: Props) {
  const [detail, setDetail] = useState<SkillDetail>();
  const [raw, setRaw] = useState<{ content: string; revision: number }>();
  const [loadError, setLoadError] = useState<string>();
  const [selected, setSelected] = useState(SKILL_MD);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [contents, setContents] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [localFolders, setLocalFolders] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<Renaming>();
  const [creating, setCreating] = useState<Creating>();
  const [failure, setFailure] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  /** The page's own confirmation: a file about to go, or an edit about to be
   *  left behind. */
  const [confirm, setConfirm] = useState<{ kind: "delete"; node: TreeNode } | { kind: "leave" }>();
  const picker = useRef<HTMLInputElement>(null);

  const revision = detail?.currentRevision ?? 0;
  const dirty = Object.keys(drafts).length > 0;
  /** Whether the package itself has a file at or under `path`. A folder the
   *  editor made and never put a file in has none: the API has nothing to
   *  rename or delete, so those two act on the local list alone. */
  const hasPackageFiles = (path: string): boolean => detail !== undefined
    && [...packagePaths(detail)].some((candidate) => candidate === path || candidate.startsWith(`${path}/`));

  useEffect(() => {
    let cancelled = false;
    setLoadError(undefined);
    Promise.all([getSkill(client, skillId), getSkillMarkdown(client, skillId)]).then(
      ([loaded, markdown]) => {
        if (cancelled) return;
        setDetail(loaded);
        setRaw({ content: markdown.content, revision: markdown.revision });
      },
      (reason: unknown) => {
        if (!cancelled) setLoadError(messageOf(reason));
      },
    );
    return () => { cancelled = true; };
  }, [client, skillId]);

  useEffect(() => {
    if (detail === undefined || selected === SKILL_MD) return;
    if (contents[selected] !== undefined || drafts[selected] !== undefined) return;
    let cancelled = false;
    setLoadingFile(true);
    readSkillResource(client, detail.id, selected).then(
      (resource) => {
        if (!cancelled) setContents((current) => ({ ...current, [selected]: resource.content }));
      },
      (reason: unknown) => {
        if (!cancelled) setFailure(messageOf(reason));
      },
    ).finally(() => {
      if (!cancelled) setLoadingFile(false);
    });
    return () => { cancelled = true; };
  }, [client, contents, detail, drafts, selected]);

  /** Take a server answer as the new truth: revision, tree and the current
   *  selection. Drafts are the caller's business. */
  const applyDetail = (next: SkillDetail, nextSelected?: string) => {
    setDetail(next);
    setRaw((current) => (current === undefined ? current : { ...current, revision: next.currentRevision }));
    if (nextSelected !== undefined) setSelected(nextSelected);
  };

  const leave = () => {
    if (!dirty) {
      onCancel();
      return;
    }
    setConfirm({ kind: "leave" });
  };

  const save = async () => {
    if (detail === undefined || !dirty || saving) return;
    setSaving(true);
    setFailure(undefined);
    let next = detail;
    const remaining = { ...drafts };
    const loadedContents = { ...contents };
    try {
      if (drafts[SKILL_MD] !== undefined) {
        next = await updateSkillMarkdown(client, skillId, {
          content: drafts[SKILL_MD],
          expectedRevision: next.currentRevision,
        });
        // Each answer lands as it arrives: a later failure must not leave the
        // editor holding the revision it read before the writes that already
        // committed, or its retry would be a conflict every time.
        setRaw({ content: drafts[SKILL_MD], revision: next.currentRevision });
        delete remaining[SKILL_MD];
        applyDetail(next);
        setDrafts({ ...remaining });
      }
      for (const [path, content] of Object.entries(drafts)) {
        if (path === SKILL_MD || remaining[path] === undefined) continue;
        next = await updateSkillFile(client, skillId, path, {
          content,
          expectedRevision: next.currentRevision,
        });
        loadedContents[path] = content;
        delete remaining[path];
        applyDetail(next);
        setContents({ ...loadedContents });
        setDrafts({ ...remaining });
      }
      setDrafts(remaining);
      setContents(loadedContents);
      onSaved(next);
    } catch (reason) {
      // Keep what landed: the next 保存 starts from the revision the server
      // already holds and resends only the drafts that failed.
      applyDetail(next);
      setDrafts({ ...remaining });
      setContents({ ...loadedContents });
      setFailure(messageOf(reason));
    } finally {
      setSaving(false);
    }
  };

  const commitRename = async () => {
    if (renaming === undefined) return;
    const value = renaming.value.trim();
    const parent = renaming.base.includes("/") ? renaming.base.split("/").slice(0, -1).join("/") : "";
    const to = parent === "" ? value : `${parent}/${value}`;
    if (to === renaming.base) {
      setRenaming(undefined);
      return;
    }
    if (validPath(to) === undefined) {
      setFailure(TEXT.settings.skills.editor.invalidPath);
      return;
    }
    const remap = (path: string) => path === renaming.base
      ? to
      : path.startsWith(`${renaming.base}/`)
        ? `${to}${path.slice(renaming.base.length)}`
        : path;
    if (!hasPackageFiles(renaming.base)) {
      setLocalFolders((current) => current.map(remap));
      setSelected((current) => remap(current));
      setRenaming(undefined);
      setFailure(undefined);
      return;
    }
    try {
      const next = await renameSkillFile(client, skillId, renaming.base, {
        expectedRevision: revision,
        to,
      });
      setDrafts((current) => Object.fromEntries(Object.entries(current).map(([path, content]) => [remap(path), content])));
      setContents((current) => Object.fromEntries(Object.entries(current).map(([path, content]) => [remap(path), content])));
      setLocalFolders((current) => current.map(remap));
      applyDetail(next, remap(selected));
      setRenaming(undefined);
      setFailure(undefined);
    } catch (reason) {
      setFailure(messageOf(reason));
    }
  };

  const commitCreate = async () => {
    if (creating === undefined) return;
    const joined = creating.kind === "file" && creating.parent !== ""
      ? `${creating.parent}/${creating.value.trim()}`
      : creating.value.trim();
    const path = validPath(joined);
    if (path === undefined) {
      setFailure(TEXT.settings.skills.editor.invalidPath);
      return;
    }
    if (creating.kind === "folder") {
      if (!localFolders.includes(path)) setLocalFolders((current) => [...current, path]);
      setCreating(undefined);
      setFailure(undefined);
      return;
    }
    if (detail === undefined) return;
    if (packagePaths(detail).has(path)) {
      setSelected(path);
      setCreating(undefined);
      return;
    }
    try {
      const next = await updateSkillFile(client, skillId, path, { content: "", expectedRevision: revision });
      setContents((current) => ({ ...current, [path]: "" }));
      applyDetail(next, path);
      setCreating(undefined);
      setFailure(undefined);
    } catch (reason) {
      setFailure(messageOf(reason));
    }
  };

  const deleteNow = async (node: TreeNode) => {
    try {
      const next = await deleteSkillFile(client, skillId, node.path, { expectedRevision: revision });
      setDrafts((current) => Object.fromEntries(
        Object.entries(current).filter(([path]) => path !== node.path && !path.startsWith(`${node.path}/`)),
      ));
      setContents((current) => Object.fromEntries(
        Object.entries(current).filter(([path]) => path !== node.path && !path.startsWith(`${node.path}/`)),
      ));
      setLocalFolders((current) => current.filter((path) => path !== node.path && !path.startsWith(`${node.path}/`)));
      applyDetail(next, selected === node.path || selected.startsWith(`${node.path}/`) ? SKILL_MD : selected);
      setFailure(undefined);
    } catch (reason) {
      setFailure(messageOf(reason));
    } finally {
      setConfirm(undefined);
    }
  };

  const deleteNode = (node: TreeNode) => {
    // A folder that only exists in this editor disappears without a request.
    if (!hasPackageFiles(node.path)) {
      setLocalFolders((current) => current.filter((path) => path !== node.path && !path.startsWith(`${node.path}/`)));
      setFailure(undefined);
      return;
    }
    setConfirm({ kind: "delete", node });
  };

  const upload = async (file: File) => {
    if (!TEXT_FILE.test(file.name)) {
      setFailure(TEXT.settings.skills.editor.uploadNotText(file.name));
      return;
    }
    const path = validPath(file.name.replace(/[\\/]/gu, "_"));
    if (path === undefined) {
      setFailure(TEXT.settings.skills.editor.invalidPath);
      return;
    }
    try {
      const content = await file.text();
      const next = await updateSkillFile(client, skillId, path, { content, expectedRevision: revision });
      setContents((current) => ({ ...current, [path]: content }));
      applyDetail(next, path);
      setFailure(undefined);
    } catch (reason) {
      setFailure(messageOf(reason));
    }
  };

  if (loadError !== undefined) {
    return (
      <div className="skill-editor-page">
        <p className="row-note is-error" role="alert">{loadError}</p>
      </div>
    );
  }
  if (detail === undefined || raw === undefined) {
    return (
      <div className="skill-editor-page">
        <p className="skill-file-note">{TEXT.settings.loading}</p>
      </div>
    );
  }

  const tree = fileTree(detail, localFolders);
  const current = selected === SKILL_MD
    ? drafts[SKILL_MD] ?? raw.content
    : drafts[selected] ?? contents[selected];

  const renderCreate = (depth: number) => (
    <div className="skill-tree-row is-editing skill-tree-create" style={{ paddingLeft: 8 + depth * 24 }}>
      <span aria-hidden="true" className="skill-tree-icon">
        <NodeGlyph folder={creating?.kind === "folder"} open />
      </span>
      <input
        aria-label={creating?.kind === "folder" ? TEXT.settings.skills.editor.newFolder : TEXT.settings.skills.editor.newFile}
        autoFocus
        className="skill-tree-input"
        onChange={(event) => {
          if (creating !== undefined) setCreating({ ...creating, value: event.target.value });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commitCreate();
          if (event.key === "Escape") setCreating(undefined);
        }}
        placeholder={creating?.kind === "folder"
          ? TEXT.settings.skills.editor.folderPathPlaceholder
          : TEXT.settings.skills.editor.filePathPlaceholder}
        value={creating?.value ?? ""}
      />
      <button
        aria-label={TEXT.settings.skills.uploadDialog.confirm}
        className="skill-tree-check"
        onClick={() => void commitCreate()}
        type="button"
      >
        <CheckGlyph />
      </button>
    </div>
  );

  const renderNode = (node: TreeNode, depth: number): ReactNode => {
    if (node.children !== undefined) {
      const open = !collapsed.has(node.path);
      if (renaming?.base === node.path) {
        return (
          <li key={node.path}>
            <div className="skill-tree-row is-editing" style={{ paddingLeft: 8 + depth * 24 }}>
              <span aria-hidden="true" className="skill-tree-caret"><CaretGlyph open={open} /></span>
              <span aria-hidden="true" className="skill-tree-icon"><NodeGlyph folder open={open} /></span>
              <input
                aria-label={TEXT.settings.skills.editor.editPath(node.path)}
                autoFocus
                className="skill-tree-input"
                onChange={(event) => setRenaming({ ...renaming, value: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void commitRename();
                  if (event.key === "Escape") setRenaming(undefined);
                }}
                value={renaming.value}
              />
              <button aria-label={TEXT.settings.skills.uploadDialog.confirm} className="skill-tree-check" onClick={() => void commitRename()} type="button">
                <CheckGlyph />
              </button>
            </div>
            {open ? (
              <ul>
                {creating?.kind === "file" && creating.parent === node.path ? <li>{renderCreate(depth + 1)}</li> : null}
                {node.children.map((child) => renderNode(child, depth + 1))}
              </ul>
            ) : null}
          </li>
        );
      }
      return (
        <li key={node.path}>
          <div className="skill-tree-row is-folder">
            <button
              aria-expanded={open}
              className="skill-tree-open"
              onClick={() => setCollapsed((currentSet) => {
                const next = new Set(currentSet);
                if (open) next.add(node.path);
                else next.delete(node.path);
                return next;
              })}
              style={{ paddingLeft: 8 + depth * 24 }}
              type="button"
            >
              <span aria-hidden="true" className="skill-tree-caret"><CaretGlyph open={open} /></span>
              <span aria-hidden="true" className="skill-tree-icon"><NodeGlyph folder open={open} /></span>
              <span className="skill-tree-name">{node.name}</span>
            </button>
            <span className="skill-tree-row-actions">
              <button aria-label={TEXT.settings.skills.editor.newFileIn(node.path)} className="skill-tree-action" data-tooltip={TEXT.settings.skills.editor.newFile} onClick={() => setCreating({ kind: "file", parent: node.path, value: "" })} type="button">
                <FileAddGlyph />
              </button>
              <button aria-label={TEXT.settings.skills.editor.editPath(node.path)} className="skill-tree-action" data-tooltip={TEXT.settings.skills.editor.rename} onClick={() => setRenaming({ base: node.path, value: node.name })} type="button">
                <EditGlyph />
              </button>
              <button aria-label={TEXT.settings.skills.editor.deletePath(node.path)} className="skill-tree-action" data-tooltip={TEXT.settings.skills.editor.deleteAction} onClick={() => deleteNode(node)} type="button">
                <DeleteGlyph />
              </button>
            </span>
          </div>
          {open ? (
            <ul>
              {creating?.kind === "file" && creating.parent === node.path ? <li>{renderCreate(depth + 1)}</li> : null}
              {node.children.map((child) => renderNode(child, depth + 1))}
            </ul>
          ) : null}
        </li>
      );
    }
    if (renaming?.base === node.path) {
      return (
        <li key={node.path}>
          <div className="skill-tree-row is-editing" style={{ paddingLeft: 8 + depth * 24 + 24 }}>
            <span aria-hidden="true" className="skill-tree-icon"><NodeGlyph folder={false} /></span>
            <input
              aria-label={TEXT.settings.skills.editor.editPath(node.path)}
              autoFocus
              className="skill-tree-input"
              onChange={(event) => setRenaming({ ...renaming, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") void commitRename();
                if (event.key === "Escape") setRenaming(undefined);
              }}
              value={renaming.value}
            />
            <button aria-label={TEXT.settings.skills.uploadDialog.confirm} className="skill-tree-check" onClick={() => void commitRename()} type="button">
              <CheckGlyph />
            </button>
          </div>
        </li>
      );
    }
    return (
      <li key={node.path}>
        <div className={`skill-tree-row${selected === node.path ? " is-active" : ""}`}>
          <button
            className="skill-tree-open"
            onClick={() => setSelected(node.path)}
            style={{ paddingLeft: 8 + depth * 24 + 24 }}
            type="button"
          >
            <span aria-hidden="true" className="skill-tree-icon"><NodeGlyph folder={false} /></span>
            <span className="skill-tree-name">{node.name}</span>
          </button>
          {node.path === SKILL_MD ? null : (
            <span className="skill-tree-row-actions">
              <button aria-label={TEXT.settings.skills.editor.editPath(node.path)} className="skill-tree-action" data-tooltip={TEXT.settings.skills.editor.rename} onClick={() => setRenaming({ base: node.path, value: node.name })} type="button">
                <EditGlyph />
              </button>
              <button aria-label={TEXT.settings.skills.editor.deletePath(node.path)} className="skill-tree-action" data-tooltip={TEXT.settings.skills.editor.deleteAction} onClick={() => deleteNode(node)} type="button">
                <DeleteGlyph />
              </button>
            </span>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="skill-editor-page">
      <button
        aria-label={TEXT.settings.skills.backToList}
        className="skill-detail-back"
        onClick={leave}
        type="button"
      >
        <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" viewBox="0 0 24 24" width="14">
          <path d="M15 5l-7 7 7 7" />
        </svg>
        {TEXT.settings.skills.back}
      </button>

      <header className="skill-detail-page-head skill-editor-head">
        <span aria-hidden="true" className={`skill-detail-page-mark is-${markTone(detail.name)}`}>
          {detail.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="skill-detail-identity">
          <h3>{detail.name}</h3>
          <span className="skill-detail-page-tag">
            {detail.source === "built-in" ? TEXT.settings.skills.cardTag.builtIn : TEXT.settings.skills.cardTag.external}
          </span>
        </div>
        <div className="skill-detail-page-actions">
          <button className="secondary-button" onClick={leave} type="button">
            {TEXT.settings.skills.editor.exit}
          </button>
          <button
            className="secondary-button"
            disabled={!dirty || saving}
            onClick={() => void save()}
            type="button"
          >
            {saving ? TEXT.settings.skills.editor.saving : TEXT.settings.skills.editor.save}
          </button>
        </div>
      </header>

      <div aria-hidden="true" className="skill-editor-divider" />

      <div className="skill-files-layout skill-editor-layout">
        <nav aria-label={TEXT.settings.skills.fileTree.list} className="skill-file-tree">
          <div className="skill-file-tree-head">
            <h4 className="skill-file-tree-title">{TEXT.settings.skills.fileTree.list}</h4>
            <span className="skill-tree-tools">
              <button aria-label={TEXT.settings.skills.editor.newFolder} className="skill-tree-tool" data-tooltip={TEXT.settings.skills.editor.newFolder} onClick={() => setCreating({ kind: "folder", parent: "", value: "" })} type="button">
                <FolderAddGlyph />
              </button>
              <button aria-label={TEXT.settings.skills.editor.newFile} className="skill-tree-tool" data-tooltip={TEXT.settings.skills.editor.newFile} onClick={() => setCreating({ kind: "file", parent: "", value: "" })} type="button">
                <FileAddGlyph />
              </button>
              <button aria-label={TEXT.settings.skills.editor.uploadFile} className="skill-tree-tool" data-tooltip={TEXT.settings.skills.editor.uploadFile} onClick={() => picker.current?.click()} type="button">
                <UploadGlyph />
              </button>
            </span>
          </div>
          <input
            accept=".md,.markdown,.txt,.json,.yaml,.yml,.csv,.tsv,.js,.mjs,.cjs,.ts,.py,.sh,.bash,.html,.htm,.css,.xml,.toml,.ini,.cfg,.conf"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
            ref={picker}
            type="file"
          />
          {creating !== undefined && creating.parent === "" ? renderCreate(0) : null}
          <ul className="skill-file-tree-list">{tree.map((node) => renderNode(node, 0))}</ul>
        </nav>
        <div aria-hidden="true" className="skill-file-tree-divider" />
        <section className="skill-file-pane">
          <div className="skill-file-head">
            <h4>{selected}</h4>
          </div>
          {failure === undefined ? null : <small className="row-note is-error" role="alert">{failure}</small>}
          {current === undefined ? (
            <p className="skill-file-note">{loadingFile ? TEXT.settings.loading : TEXT.settings.skills.fileTree.reading}</p>
          ) : (
            <div className="skill-file-editor-box">
              <textarea
                aria-label={TEXT.settings.skills.editor.content}
                onChange={(event) => {
                  setDrafts((draftMap) => ({ ...draftMap, [selected]: event.target.value }));
                }}
                onKeyDown={(event) => {
                  if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void save();
                  }
                }}
                spellCheck={false}
                value={current}
              />
            </div>
          )}
        </section>
      </div>
      {confirm === undefined ? null : confirm.kind === "leave" ? (
        <SkillConfirmDialog
          body={TEXT.settings.skills.editor.unsavedBody}
          onAccept={() => {
            setConfirm(undefined);
            onCancel();
          }}
          onCancel={() => setConfirm(undefined)}
          title={TEXT.settings.skills.editor.unsavedTitle}
        />
      ) : (
        <SkillConfirmDialog
          body={TEXT.settings.skills.editor.deleteBody}
          compactBody
          onAccept={() => deleteNow(confirm.node)}
          onCancel={() => setConfirm(undefined)}
          title={TEXT.settings.skills.editor.deleteTitle}
        />
      )}
    </div>
  );
}
