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

import { ApiRequestError, type ApiClient } from "../../api/client.js";
import { getSkill, readSkillResource, renameSkillFile } from "../../api/settings.js";
import type { SkillDetail } from "../../api/types.js";
import { MarkdownProse } from "../../MarkdownProse.js";
import { skillMark } from "../../app/slash.js";
import { useLoaded } from "../../app/use-loaded.js";
import { TEXT } from "../../text.js";
import { LoadGate, Switch } from "./rows.js";
import { SkillRowMenu } from "./SkillRowMenu.js";
import { fileTree, packagePaths, resolvePackageLink, validPackagePath, type TreeNode } from "./skill-files.js";
import { CaretGlyph, NodeGlyph } from "./skill-tree-glyphs.js";
import { markTone } from "./skill-tone.js";

interface Props {
  client: ApiClient;
  /** Whether JiuwenSwarm currently has the package switched on. */
  enabled?: boolean;
  /** Which tab opens first. Coming back from the editor lands on 技能详情,
   *  where the file that was just edited lives. */
  initialTab?: "basic" | "files";
  onBack: () => void;
  onDelete: (skill: SkillDetail) => void;
  onEdit: (skill: SkillDetail) => void;
  onToggle: (skill: SkillDetail, next: boolean) => void;
  /** A switch or another write for this package is in flight. */
  pending?: boolean;
  skillId: string;
  switchesAvailable: boolean;
}

/** Frontmatter keys that are already on the page: the name in the header and
 *  the description the document opens with. */
const SHOWN_ELSEWHERE = new Set(["name", "description", "version"]);

/** One frontmatter value as a reader can read it, or nothing. */
function factValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number")) {
    const text = value.map(String).filter((item) => item.trim().length > 0);
    return text.length === 0 ? undefined : text.join(", ");
  }
  return undefined;
}

/** A fact's label: the two canonical fields the app names itself, and the
 *  package's own key for everything else, with punctuation turned back into
 *  words (`allowed-tools` → `Allowed tools`). */
function factLabel(key: string): string {
  if (key === "license") return TEXT.settings.skills.license;
  if (key === "compatibility") return TEXT.settings.skills.compatibility;
  const words = key.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function detailFacts(detail: SkillDetail): Array<{ label: string; value: string }> {
  const entries = Object.entries(detail.frontmatter)
    .filter(([key]) => !SHOWN_ELSEWHERE.has(key))
    .flatMap(([key, raw]) => {
      const value = factValue(raw);
      return value === undefined ? [] : [{ key, label: factLabel(key), value }];
    });
  // The licence leads, as it does in the package's own frontmatter; the rest
  // keep the order the author wrote them in.
  return entries.toSorted((left, right) => Number(right.key === "license") - Number(left.key === "license"));
}

const CopyGlyph = () => (
  <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="16">
    <rect height="12" rx="2" width="12" x="8" y="8" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
);

const DownloadGlyph = () => (
  <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="16">
    <path d="M12 4v11m-4-4 4 4 4-4M5 19h14" />
  </svg>
);

const PencilGlyph = () => (
  <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24" width="16">
    <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    <path d="m17.4 3.6 2.9 2.9-7.1 7.1-3.5.7.7-3.5z" />
  </svg>
);

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="skill-detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/**
 * 技能 › one Skill, as the handoff draws 2-1 and 2-2.
 *
 * 基本信息 is the package's own document, read down a measured column. 技能详情
 * asks a different question — which files make up the package — and puts the
 * tree beside the file it opens. SKILL.md comes from the detail; every other
 * file is read on demand, and a file the server cannot decode (binary, too
 * large) says so in the pane rather than blanking the page.
 */
export function SkillDetailView({
  client,
  enabled,
  initialTab,
  onBack,
  onDelete,
  onEdit,
  onToggle,
  pending,
  skillId,
  switchesAvailable,
}: Props) {
  const [tab, setTab] = useState<"basic" | "files">(initialTab ?? "basic");
  const [selected, setSelected] = useState("SKILL.md");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [contents, setContents] = useState<Record<string, string | { error: string }>>({});
  const [copied, setCopied] = useState(false);
  /** A name being edited in place: a double press on the row opens it. */
  const [renaming, setRenaming] = useState<{ base: string; value: string }>();
  const [failure, setFailure] = useState<string>();
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loaded = useLoaded(async () => getSkill(client, skillId), {
    client,
    key: `skills:detail:${skillId}`,
  });

  const detail = loaded.value;
  const selectedContent = detail === undefined
    ? undefined
    : selected === "SKILL.md"
      ? detail.instructions
      : contents[selected];

  useEffect(() => {
    if (detail === undefined || tab !== "files" || selected === "SKILL.md") return;
    if (contents[selected] !== undefined) return;
    let cancelled = false;
    readSkillResource(client, detail.id, selected).then(
      (resource) => {
        if (!cancelled) setContents((current) => ({ ...current, [selected]: resource.content }));
      },
      (reason: unknown) => {
        if (!cancelled) {
          const message = reason instanceof Error ? reason.message : TEXT.settings.skills.fileTree.reading;
          setContents((current) => ({ ...current, [selected]: { error: message } }));
        }
      },
    );
    return () => { cancelled = true; };
  }, [client, contents, detail, selected, tab]);

  useEffect(() => () => {
    if (copyTimer.current !== undefined) clearTimeout(copyTimer.current);
  }, []);

  // A link at the bottom of a long document opens a file whose title is far
  // above the reader's scroll position; bring the pane's head back into view
  // so the change is visible where it happened.
  const pane = useRef<HTMLElement>(null);
  useEffect(() => {
    if (tab !== "files") return;
    const head = pane.current?.querySelector(".skill-file-head");
    if (head !== null && head !== undefined && typeof head.scrollIntoView === "function") {
      head.scrollIntoView({ block: "nearest" });
    }
  }, [selected, tab]);

  const copy = async () => {
    const text = typeof selectedContent === "string" ? selectedContent : "";
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      if (copyTimer.current !== undefined) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1_500);
    } catch {
      // A browser that refuses the clipboard says nothing; the file is still
      // on screen to select by hand.
    }
  };

  const download = () => {
    if (typeof selectedContent !== "string" || typeof document.createElement !== "function") return;
    const blob = new Blob([selectedContent], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.download = selected.split("/").pop() ?? "file";
    anchor.href = url;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <LoadGate loaded={loaded}>
      {(skill) => {
        const facts = detailFacts(skill);
        const tag = skill.source === "built-in"
          ? TEXT.settings.skills.cardTag.builtIn
          : TEXT.settings.skills.cardTag.external;
        const canEdit = skill.source === "managed" && !skill.readOnly;
        const tree = fileTree(skill);
        const filePaths = packagePaths(skill);
        const openLinkedFile = (href: string): boolean => {
          // A package link usually resolves from the file the reader is in.
          // References often write paths from the package root, though, so
          // the root is tried second rather than refusing a real file.
          const path = [resolvePackageLink(href, selected), resolvePackageLink(href, "SKILL.md")]
            .find((candidate) => candidate !== undefined && filePaths.has(candidate));
          if (path === undefined) return false;
          setTab("files");
          setSelected(path);
          return true;
        };
        const isMarkdown = /\.(md|markdown)$/iu.test(selected);
        const failing = selectedContent !== undefined && typeof selectedContent !== "string";

        /** Rename a file or a folder from the reading page. A built-in is
         *  read-only, so the rows offer no double-press there. */
        const commitRename = async (base: string) => {
          if (renaming === undefined) return;
          const parent = base.includes("/") ? base.split("/").slice(0, -1).join("/") : "";
          const value = renaming.value.trim();
          const to = parent === "" ? value : `${parent}/${value}`;
          if (to === base) {
            setRenaming(undefined);
            return;
          }
          if (validPackagePath(to) === undefined) {
            setFailure(TEXT.settings.skills.editor.invalidPath);
            return;
          }
          try {
            await renameSkillFile(client, skill.id, base, {
              expectedRevision: skill.currentRevision,
              to,
            });
            const remap = (path: string) => path === base
              ? to
              : path.startsWith(`${base}/`)
                ? `${to}${path.slice(base.length)}`
                : path;
            setContents((current) => Object.fromEntries(
              Object.entries(current).map(([path, content]) => [remap(path), content]),
            ));
            setSelected((current) => remap(current));
            setRenaming(undefined);
            setFailure(undefined);
            loaded.reload();
          } catch (reason) {
            setFailure(reason instanceof ApiRequestError && reason.status === 409
              ? TEXT.settings.skills.editor.conflict
              : reason instanceof Error ? reason.message : TEXT.settings.skills.editor.saveFailed);
          }
        };
        const renameRow = (base: string, depth: number, folder: boolean) => (
          <div className="skill-tree-row is-editing" style={{ paddingLeft: 8 + depth * 24 + (folder ? 0 : 24) }}>
            {folder ? <span aria-hidden="true" className="skill-tree-caret"><CaretGlyph open /></span> : null}
            <span aria-hidden="true" className="skill-tree-icon"><NodeGlyph folder={folder} open={folder} /></span>
            <input
              aria-label={TEXT.settings.skills.editor.editPath(base)}
              autoFocus
              className="skill-tree-input"
              onChange={(event) => setRenaming({ base, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") void commitRename(base);
                if (event.key === "Escape") setRenaming(undefined);
              }}
              value={renaming?.value ?? ""}
            />
            <button
              aria-label={TEXT.settings.skills.uploadDialog.confirm}
              className="skill-tree-check"
              onClick={() => void commitRename(base)}
              type="button"
            >
              <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="16">
                <path d="m5 12 4.5 4.5L19 7" />
              </svg>
            </button>
          </div>
        );

        const renderNode = (node: TreeNode, depth: number): ReactNode => {
          if (node.children !== undefined) {
            const open = !collapsed.has(node.path);
            return (
              <li key={node.path === "" ? "root" : node.path}>
                {renaming?.base === node.path ? renameRow(node.path, depth, true) : (
                <button
                  aria-expanded={open}
                  className="skill-tree-row is-folder"
                  onClick={() => setCollapsed((current) => {
                    const next = new Set(current);
                    if (open) next.add(node.path);
                    else next.delete(node.path);
                    return next;
                  })}
                  onDoubleClick={canEdit ? () => {
                    setFailure(undefined);
                    setRenaming({ base: node.path, value: node.name });
                  } : undefined}
                  style={{ paddingLeft: 8 + depth * 24 }}
                  type="button"
                >
                  <span aria-hidden="true" className="skill-tree-caret"><CaretGlyph open={open} /></span>
                  <span aria-hidden="true" className="skill-tree-icon"><NodeGlyph folder open={open} /></span>
                  <span className="skill-tree-name">{node.name}</span>
                </button>
                )}
                {open ? (
                  <ul>{node.children.map((child) => renderNode(child, depth + 1))}</ul>
                ) : null}
              </li>
            );
          }
          return (
            <li key={node.path}>
              {renaming?.base === node.path ? renameRow(node.path, depth, false) : (
              <button
                className={`skill-tree-row${selected === node.path ? " is-active" : ""}`}
                onClick={() => setSelected(node.path)}
                onDoubleClick={canEdit && node.path !== "SKILL.md" ? () => {
                  setFailure(undefined);
                  setRenaming({ base: node.path, value: node.name });
                } : undefined}
                style={{ paddingLeft: 8 + depth * 24 + 24 }}
                type="button"
              >
                <span aria-hidden="true" className="skill-tree-icon"><NodeGlyph folder={false} /></span>
                <span className="skill-tree-name">{node.name}</span>
              </button>
              )}
            </li>
          );
        };

        return (
          <div className="skill-detail-page">
            <button
              aria-label={TEXT.settings.skills.backToList}
              className="skill-detail-back"
              onClick={onBack}
              type="button"
            >
              <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" viewBox="0 0 24 24" width="14">
                <path d="M15 5l-7 7 7 7" />
              </svg>
              {TEXT.settings.skills.back}
            </button>

            <header className="skill-detail-page-head">
              <span aria-hidden="true" className={`skill-detail-page-mark is-${markTone(skill.name)}`}>
                {skillMark(skill)}
              </span>
              <div className="skill-detail-identity">
                <h3>{skill.name}</h3>
                <span className="skill-detail-page-tag">{tag}</span>
              </div>
              <div className="skill-detail-page-actions">
                {canEdit ? (
                  <button className="skill-detail-action" onClick={() => onEdit(skill)} type="button">
                    <PencilGlyph />
                    {TEXT.settings.skills.rowMenu.edit}
                  </button>
                ) : null}
                {switchesAvailable ? (
                  <span className="skill-detail-toggle">
                    <Switch
                      disabled={pending}
                      label={TEXT.settings.skills.toggle(skill.name)}
                      onChange={(next) => onToggle(skill, next)}
                      small
                      value={enabled ?? false}
                    />
                    <span>{enabled ? TEXT.settings.skills.on : TEXT.settings.skills.off}</span>
                  </span>
                ) : null}
                <SkillRowMenu
                  canDelete={skill.source === "managed"}
                  canEdit={false}
                  canExport={false}
                  disabled={pending}
                  name={skill.name}
                  onAction={(action) => {
                    if (action === "delete") onDelete(skill);
                  }}
                />
              </div>
            </header>

            <div className="skill-detail-tabs" role="tablist">
              <button
                aria-selected={tab === "basic"}
                className={`skill-detail-tab${tab === "basic" ? " is-active" : ""}`}
                onClick={() => setTab("basic")}
                role="tab"
                type="button"
              >
                {TEXT.settings.skills.tabs.basic}
              </button>
              <button
                aria-selected={tab === "files"}
                className={`skill-detail-tab${tab === "files" ? " is-active" : ""}`}
                onClick={() => setTab("files")}
                role="tab"
                type="button"
              >
                {TEXT.settings.skills.tabs.files}
              </button>
            </div>

            {tab === "basic" ? (
              <article className="skill-detail-doc text">
                {skill.instructions.trim() === "" ? (
                  <p className="skill-detail-description">{skill.description}</p>
                ) : (
                  <MarkdownProse onFileLink={openLinkedFile}>{skill.instructions}</MarkdownProse>
                )}
                {facts.length === 0 ? null : (
                  <section className="skill-detail-facts">
                    <h4>{TEXT.settings.skills.detail}</h4>
                    <div className="skill-detail-meta-card">
                      {facts.map((fact) => <DetailRow key={fact.label} label={fact.label} value={fact.value} />)}
                    </div>
                  </section>
                )}
              </article>
            ) : (
              <div className="skill-files-layout">
                <nav aria-label={TEXT.settings.skills.fileTree.list} className="skill-file-tree">
                  <h4 className="skill-file-tree-title">{TEXT.settings.skills.fileTree.list}</h4>
                  <ul className="skill-file-tree-list">{tree.map((node) => renderNode(node, 0))}</ul>
                </nav>
                <div aria-hidden="true" className="skill-file-tree-divider" />
                <section className="skill-file-pane" ref={pane}>
                  <div className="skill-file-head">
                    <h4>{selected}</h4>
                    <span className="skill-file-actions">
                      <button
                        aria-label={TEXT.settings.skills.fileTree.copy}
                        className="skill-file-action"
                        onClick={() => void copy()}
                        title={TEXT.settings.skills.fileTree.copy}
                        type="button"
                      >
                        <CopyGlyph />
                      </button>
                      <button
                        aria-label={TEXT.settings.skills.fileTree.download}
                        className="skill-file-action"
                        onClick={download}
                        title={TEXT.settings.skills.fileTree.download}
                        type="button"
                      >
                        <DownloadGlyph />
                      </button>
                    </span>
                    {copied ? (
                      <span className="skill-file-copied" role="status">
                        {TEXT.settings.skills.fileTree.copied}
                      </span>
                    ) : null}
                  </div>
                  {failure === undefined ? null : (
                    <small className="row-note is-error" role="alert">{failure}</small>
                  )}
                  {selectedContent === undefined ? (
                    <p className="skill-file-note">{TEXT.settings.skills.fileTree.reading}</p>
                  ) : failing ? (
                    <p className="skill-file-note is-error" role="alert">
                      {(selectedContent as { error: string }).error}
                    </p>
                  ) : isMarkdown ? (
                    <div className="skill-file-doc text">
                      <MarkdownProse onFileLink={openLinkedFile}>{selectedContent as string}</MarkdownProse>
                    </div>
                  ) : (
                    <pre className="skill-file-pre">{selectedContent as string}</pre>
                  )}
                </section>
              </div>
            )}
          </div>
        );
      }}
    </LoadGate>
  );
}
