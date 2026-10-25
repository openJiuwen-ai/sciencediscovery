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

import { lazy, Suspense, useEffect, useRef, useState } from "react";

import type { PanelResize } from "../app/use-panel-width.js";
import type { PreviewSlot, TabState, WorkspaceActions } from "../app/use-workspace.js";
import { buildFileTree, type FileTreeNode } from "../app/file-tree.js";
import { fileName } from "../app/paths.js";
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, PANEL_NUDGE_STEP, PANEL_NUDGE_STRIDE } from "../app/panel-width.js";
import { Markdown } from "../Markdown.js";
import { detectStructureFormat } from "../molecular.js";
import type { SessionArtifactOutput, WorkspaceFile } from "../api/types.js";
import { TEXT } from "../text.js";

/** Loaded on the first structure that is opened. Mol* is an order of magnitude
 *  larger than the rest of the app together, and most sessions never show one. */
const StructureViewer = lazy(() => import("./StructureViewer.js"));

export type PanelGroup = "team" | "artifacts" | "files";

interface Props {
  actions: WorkspaceActions;
  activeGroup: PanelGroup;
  files: WorkspaceFile[];
  onCollapse: () => void;
  onSelectGroup: (group: PanelGroup) => void;
  outputs: SessionArtifactOutput[];
  resize: PanelResize;
  tabs: TabState;
}

function GroupIcon({ group }: { group: PanelGroup }) {
  if (group === "team") {
    return (
      <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="16">
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 19c0-2.8 2.5-5 5.5-5s5.5 2.2 5.5 5" />
        <path d="M16 5.5a3 3 0 0 1 0 5.8M17.5 14.4c1.8.7 3 2.4 3 4.6" />
      </svg>
    );
  }
  if (group === "artifacts") {
    return (
      <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="16">
        <path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z" />
        <path d="M14 3.5V8h4" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="16">
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return TEXT.workspace.justNow;
  if (minutes < 60) return TEXT.workspace.minutesAgo(minutes);
  if (minutes < 60 * 24) return TEXT.workspace.hoursAgo(Math.round(minutes / 60));
  return new Date(time).toLocaleDateString(TEXT.languageTag);
}

function previewName(label: string, path: string): string {
  return path === "" ? label : path;
}

interface Expandable {
  expanded: boolean;
  onExpand: (next: boolean) => void;
}

/** Markdown and JSON get a rendered/textual preview; a structure file gets the
 *  3D view; HTML is sandboxed in a frame, which is how the handoff shows a
 *  generated page. Everything else is shown as source. */
function Preview({ content, expanded, label, onExpand, path }: Expandable & { content: string; label: string; path: string }) {
  const name = previewName(label, path);
  const format = detectStructureFormat({ content, name });
  if (format !== undefined) {
    return (
      <Suspense fallback={<div className="doc-placeholder"><span className="spinner" /></div>}>
        <StructureViewer content={content} expanded={expanded} format={format} name={name} onExpand={onExpand} />
      </Suspense>
    );
  }
  const lower = name.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return <iframe className="artifact-html-frame" sandbox="allow-scripts" srcDoc={content} title={name} />;
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return (
      <div className="text">
        <Markdown>{content}</Markdown>
      </div>
    );
  }
  if (lower.endsWith(".json")) {
    let pretty = content;
    try {
      pretty = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // Not JSON after all; the raw text is what the user should see.
    }
    return <pre className="tab-content-source">{pretty}</pre>;
  }
  if (content === "") return <div className="doc-placeholder">{TEXT.workspace.unsupported}</div>;
  return <pre className="tab-content-source">{content}</pre>;
}

function Document({ expanded, onExpand, slot }: Expandable & { slot: PreviewSlot }) {
  if (slot.loading) return <div className="doc-placeholder"><span className="spinner" /></div>;
  if (slot.error !== undefined) return <div className="panel-empty">{slot.error}</div>;
  return <Preview content={slot.content ?? ""} expanded={expanded} label={slot.label} onExpand={onExpand} path={slot.path} />;
}

/** The team view is honest about its absence: this build runs one model, and a
 *  row of invented agents would be a claim the service cannot back. */
function TeamView() {
  return (
    <div className="team-view">
      <div className="team-list">
        <div className="team-list-title">{TEXT.workspace.teamTitle}</div>
        <div className="side-empty">{TEXT.workspace.teamActive(0)}</div>
      </div>
      <div className="team-empty">
        <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" viewBox="0 0 24 24">
          <circle cx="9" cy="8" r="3" />
          <path d="M3.5 19c0-2.8 2.5-5 5.5-5s5.5 2.2 5.5 5" />
          <path d="M16 5.5a3 3 0 0 1 0 5.8M17.5 14.4c1.8.7 3 2.4 3 4.6" />
        </svg>
        <strong>{TEXT.workspace.teamEmpty}</strong>
        <span>{TEXT.workspace.teamEmptyHint}</span>
      </div>
    </div>
  );
}

/* ── artifact and file lists ────────────────────────────────────────────── */

function artifactName(output: SessionArtifactOutput): string {
  return output.artifact.title ?? fileName(output.artifact.name);
}

function ArtifactList({
  actions,
  activeId,
  outputs,
  query,
}: {
  actions: WorkspaceActions;
  activeId?: string;
  outputs: SessionArtifactOutput[];
  query: string;
}) {
  const needle = query.trim().toLowerCase();
  const shown = outputs.filter((output) =>
    needle === "" || artifactName(output).toLowerCase().includes(needle));
  if (shown.length === 0) {
    return <div className="panel-empty">{TEXT.workspace.empty}</div>;
  }
  return (
    <>
      {shown.map((output) => (
        <button
          className={`panel-list-row${output.version.id === activeId ? " is-active" : ""}`}
          key={output.version.id}
          onClick={() => void actions.openArtifact(output)}
          title={output.artifact.description ?? output.artifact.name}
          type="button"
        >
          <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="15">
            <path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z" />
            <path d="M14 3.5V8h4" />
          </svg>
          <span className="label">{artifactName(output)}</span>
        </button>
      ))}
    </>
  );
}

function TreeLevel({ actions, activePath, node, query }: {
  actions: WorkspaceActions;
  activePath?: string;
  node: FileTreeNode;
  query: string;
}) {
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const needle = query.trim().toLowerCase();
  const matches = (name: string) => needle === "" || name.toLowerCase().includes(needle);
  return (
    <>
      {node.subdirectories.map((child) => {
        const open = folded[child.path] !== false;
        return (
          <div key={child.path}>
            <button
              aria-expanded={open}
              className={`panel-list-row is-folder${open ? " is-open" : ""}`}
              onClick={() => setFolded((current) => ({ ...current, [child.path]: !open }))}
              type="button"
            >
              <span className="tree-chev">▸</span>
              <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="15">
                <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
              </svg>
              <span className="label">{child.name}</span>
            </button>
            {open ? (
              <div className="panel-list-group">
                <TreeLevel actions={actions} activePath={activePath} node={child} query={query} />
              </div>
            ) : null}
          </div>
        );
      })}
      {node.files.filter((file) => matches(fileName(file.path))).map((file) => (
        <button
          className={`panel-list-row${file.path === activePath ? " is-active" : ""}`}
          key={file.path}
          onClick={() => void actions.openFile(file)}
          title={`${file.path} · ${formatSize(file.size)} · ${formatTime(file.modifiedAt)}`}
          type="button"
        >
          <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="15">
            <path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z" />
            <path d="M14 3.5V8h4" />
          </svg>
          <span className="label">{fileName(file.path)}</span>
        </button>
      ))}
    </>
  );
}

function PanelSearch({ label, onChange, placeholder, value }: {
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <label className="panel-search">
      <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 24 24" width="14">
        <circle cx="11" cy="11" r="6.2" />
        <path d="M16 16l4 4" />
      </svg>
      <input
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type="search"
        value={value}
      />
    </label>
  );
}

/**
 * The right column: 团队, 产物 and 工作区.
 *
 * The group tabs are the handoff's, and so is the shape under them: 团队 is a
 * whole-panel view, while 产物 and 工作区 keep a 240px list on the left and open
 * the selected document in tabs on the right. A document belongs to the group
 * it was opened from, so switching groups does not show an artifact under the
 * workspace tab. 任务 is not a tab: the run's progress is already the
 * conversation, and a second list of the same tool calls said nothing new.
 */
export function WorkspacePanel({
  actions,
  activeGroup,
  files,
  onCollapse,
  onSelectGroup,
  outputs,
  resize,
  tabs,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [artifactQuery, setArtifactQuery] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const body = useRef<HTMLDivElement>(null);

  const docs = tabs.tabs.filter((slot) => !slot.home && slot.source === (activeGroup === "files" ? "file" : "artifact"));
  const active = tabs.tabs.find((slot) => slot.id === tabs.activeTabId && docs.includes(slot));
  const activeArtifact = activeGroup === "artifacts"
    ? outputs.find((output) => output.version.id === tabs.tabs.find((slot) => slot.id === tabs.activeTabId)?.artifactId)
    : undefined;

  useEffect(() => {
    setExpanded(false);
  }, [tabs.activeTabId]);

  const activeName = active === undefined ? "" : previewName(active.label, active.path);
  const structure =
    active !== undefined
    && !active.loading
    && detectStructureFormat({ content: active.content ?? "", name: activeName }) !== undefined;

  const groups: { id: PanelGroup; label: string }[] = [
    { id: "team", label: TEXT.workspace.groups.team },
    { id: "artifacts", label: TEXT.workspace.groups.artifacts },
    { id: "files", label: TEXT.workspace.groups.files },
  ];

  const docArea = (
    <div className="panel-doc">
      {docs.length === 0 ? (
        <div className="doc-placeholder">
          <span aria-hidden="true" className="mark">
            <GroupIcon group={activeGroup} />
          </span>
          <span>{activeGroup === "artifacts" ? TEXT.workspace.empty : TEXT.workspace.filesEmpty}</span>
        </div>
      ) : (
        <>
          <div className="doc-tabs">
            <div className="doc-tabs" role="tablist">
              {docs.map((slot) => {
                const isActive = slot.id === tabs.activeTabId;
                return (
                  <div className={`doc-tab${isActive ? " is-active" : ""}`} key={slot.id} role="presentation">
                    <button
                      aria-selected={isActive}
                      className="doc-tab-label"
                      onClick={() => actions.selectPanelTab(slot.id)}
                      role="tab"
                      title={slot.path === "" ? undefined : slot.path}
                      type="button"
                    >
                      {slot.label}
                    </button>
                    <button
                      aria-label={TEXT.workspace.closeTab}
                      className="doc-tab-close"
                      onClick={() => {
                        if (actions.closeTab(slot.id)) onCollapse();
                      }}
                      title={TEXT.workspace.closeTab}
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <button
                aria-label={TEXT.workspace.addTab}
                className="doc-tab-more"
                onClick={actions.addPanelTab}
                title={TEXT.workspace.addTab}
                type="button"
              >
                +
              </button>
            </div>
            <div className="doc-tabs-actions">
              {activeArtifact ? (
                <button
                  aria-label={TEXT.workspace.download}
                  className="panel-icon-button"
                  onClick={() => {
                    const blob = new Blob([active?.content ?? ""], { type: "text/plain" });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.download = fileName(activeArtifact.artifact.name);
                    link.href = url;
                    link.click();
                    URL.revokeObjectURL(url);
                  }}
                  title={TEXT.workspace.download}
                  type="button"
                >
                  <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24" width="15">
                    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14" />
                  </svg>
                </button>
              ) : null}
            </div>
          </div>
          <div className="doc-body" ref={body}>
            {active === undefined ? (
              <div className="doc-placeholder">{TEXT.workspace.open}</div>
            ) : structure ? (
              <Document expanded={expanded} onExpand={setExpanded} slot={active} />
            ) : (
              <div className="artifact-canvas">
                <Document expanded={expanded} onExpand={setExpanded} slot={active} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <aside className="workspace-panel">
      <div
        aria-label={TEXT.workspace.resize}
        aria-orientation="vertical"
        aria-valuemax={PANEL_MAX_WIDTH}
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuenow={resize.width}
        className="workspace-splitter"
        onKeyDown={(event) => {
          const grow = event.key === "ArrowLeft";
          if (!grow && event.key !== "ArrowRight") return;
          event.preventDefault();
          const step = event.shiftKey ? PANEL_NUDGE_STRIDE : PANEL_NUDGE_STEP;
          resize.nudge(grow ? step : -step);
        }}
        onPointerDown={resize.start}
        role="separator"
        tabIndex={0}
      />
      <header className="panel-head">
        <div className="panel-group-tabs" role="tablist">
          {groups.map((group) => (
            <button
              aria-selected={activeGroup === group.id}
              className={`panel-group-tab${activeGroup === group.id ? " is-active" : ""}`}
              key={group.id}
              onClick={() => onSelectGroup(group.id)}
              role="tab"
              type="button"
            >
              <GroupIcon group={group.id} />
              <span>{group.label}</span>
            </button>
          ))}
        </div>
        <div className="panel-head-actions">
          <button
            aria-label={TEXT.workspace.collapsePanel}
            className="panel-icon-button"
            onClick={onCollapse}
            title={TEXT.workspace.collapsePanel}
            type="button"
          >
            <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24" width="15">
              <rect height="14" rx="2.5" stroke="currentColor" strokeWidth="1.7" width="18" x="3" y="5" />
              <path d="M15 5v14" stroke="currentColor" strokeWidth="1.7" />
            </svg>
          </button>
        </div>
      </header>

      <div className="panel-body">
        {activeGroup === "team" ? (
          <TeamView />
        ) : activeGroup === "artifacts" ? (
          <>
            <div className="panel-list">
              <div className="panel-list-title">{TEXT.workspace.allArtifacts}</div>
              <PanelSearch
                label={TEXT.workspace.searchArtifacts}
                onChange={setArtifactQuery}
                placeholder={TEXT.workspace.searchArtifacts}
                value={artifactQuery}
              />
              <ArtifactList
                actions={actions}
                activeId={tabs.tabs.find((slot) => slot.id === tabs.activeTabId)?.artifactId}
                outputs={outputs}
                query={artifactQuery}
              />
            </div>
            {docArea}
          </>
        ) : (
          <>
            <div className="panel-list">
              <div className="panel-list-title">{TEXT.workspace.collapsible}</div>
              <PanelSearch
                label={TEXT.workspace.searchFiles}
                onChange={setFileQuery}
                placeholder={TEXT.workspace.searchFiles}
                value={fileQuery}
              />
              {files.length === 0 ? (
                <div className="panel-empty">{TEXT.workspace.filesEmpty}</div>
              ) : (
                <TreeLevel
                  actions={actions}
                  activePath={active?.path}
                  node={buildFileTree(files)}
                  query={fileQuery}
                />
              )}
            </div>
            {docArea}
          </>
        )}
      </div>
    </aside>
  );
}
