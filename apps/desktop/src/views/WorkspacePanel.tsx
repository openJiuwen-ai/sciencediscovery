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

import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { PanelResize } from "../app/use-panel-width.js";
import type { PreviewSlot, TabState, WorkspaceActions } from "../app/use-workspace.js";
import { artifactGroups, type ArtifactGroup } from "../app/artifact-groups.js";
import { artifactHints, artifactName, artifactPath, versionsOf } from "../app/artifact-labels.js";
import { buildFileTree, filterFileTree, type FileTreeNode } from "../app/file-tree.js";
import { DOC_MIN_WIDTH, LIST_MIN_WIDTH, LIST_NUDGE_STEP, isListClosed, listWidth } from "../app/panel-split.js";
import { usePanelSplit } from "../app/use-panel-split.js";
import { fileFolder, fileName } from "../app/paths.js";
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, PANEL_NUDGE_STEP, PANEL_NUDGE_STRIDE } from "../app/panel-width.js";
import type { ToolDetail as ToolDetailData } from "../app/tool-io.js";
import { detectStructureFormat } from "../molecular.js";
import type { Session, SessionArtifactOutput, Subagent, WorkspaceFile } from "../api/types.js";
import { subagentTask } from "../run-stream/subagent.js";
import { TEXT } from "../text.js";
import { DocumentPreview } from "./DocumentPreview.js";
import { SubagentDetail } from "./SubagentDetail.js";
import { ToolDetail } from "./ToolDetail.js";

export type PanelGroup = "artifacts" | "files";

interface Props {
  actions: WorkspaceActions;
  activeGroup: PanelGroup;
  files: WorkspaceFile[];
  /** Leaves a child's or a tool's record for the panel's own groups. It is the
   *  way out of the mode `subagent` and `tool` open. */
  onCloseDetail: () => void;
  onCollapse: () => void;
  onSelectGroup: (group: PanelGroup) => void;
  outputs: SessionArtifactOutput[];
  resize: PanelResize;
  /** The Session whose artifacts head the list, and which a row with no Session
   *  of its own falls back to. */
  sessionId?: string;
  /** Every Session the app knows about, newest first: the artifact list shows
   *  their output too, grouped under each Session's name. */
  sessions?: Session[];
  /** The subagent whose execution is open. While set, the panel shows only
   *  that child's record — it is not a tab beside 产物 and 工作区. */
  subagent?: Subagent;
  /** The catalog read that fills a replayed child's steps is still in flight. */
  subagentLoading?: boolean;
  /** One input or result block of a tool call, opened from the run. It is the
   *  same mode as `subagent`: the panel shows only that text. */
  tool?: ToolDetailData;
  tabs: TabState;
}

function GroupIcon({ group }: { group: PanelGroup }) {
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

/**
 * Save the open document under the name the reader knows it by.
 *
 * A drawn document is already a data URL and is saved from it as it stands; a
 * text one becomes a blob, which is the only thing a link will take for text.
 * An artifact's file name comes from the artifact itself, since its version
 * may carry no path at all.
 */
function downloadDocument(slot: PreviewSlot, artifact: SessionArtifactOutput | undefined): void {
  const name = fileName(artifact === undefined ? slot.path : artifact.artifact.name);
  if (slot.dataUrl !== undefined) {
    const link = document.createElement("a");
    link.download = name;
    link.href = slot.dataUrl;
    link.click();
    return;
  }
  const url = URL.createObjectURL(new Blob([slot.content ?? ""], { type: slot.mediaType ?? "text/plain" }));
  const link = document.createElement("a");
  link.download = name;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}

/* ── artifact and file lists ────────────────────────────────────────────── */

function ArtifactList({
  actions,
  activeId,
  groups,
  hints,
  query,
}: {
  actions: WorkspaceActions;
  activeId?: string;
  /** The Sessions' artifacts, the open Session's first. */
  groups: ArtifactGroup[];
  /** What tells each colliding row apart — see `artifactHints`. */
  hints: Map<string, string>;
  query: string;
}) {
  // A Session's group folds away, the way a folder does in the tree beside it.
  // The open Session's group is open; the others start closed, so the list
  // opens on the work in hand and the rest is one click away rather than
  // pushing it down. Only the reader's own choices are recorded here — the
  // default belongs to `artifactGroups`, which is what knows which group is
  // the open one.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const needle = query.trim().toLowerCase();
  // The path is searchable too: when two artifacts share a name, the folder is
  // the only thing the reader can type to reach the one they mean.
  const shown = groups
    .map((group) => ({
      group,
      outputs: group.outputs.filter((output) =>
        needle === ""
        || artifactName(output).toLowerCase().includes(needle)
        || artifactPath(output).toLowerCase().includes(needle)),
    }))
    .filter(({ outputs }) => outputs.length > 0);
  if (shown.length === 0) {
    return (
      <div className="panel-empty">
        {needle === "" ? TEXT.workspace.empty : TEXT.workspace.searchEmpty}
      </div>
    );
  }
  // Every group is headed by the Session that made its files, even when there
  // is only one: an artifact belongs to a Session, and a list that names the
  // Session only once a second one exists changes shape as a Project grows.
  return (
    <>
      {shown.map(({ group, outputs }) => {
        // A search opens every group it reaches: a match behind a fold is a
        // match the reader cannot see, and typing is already a request to see
        // what is there. The fold is remembered for when the search is cleared.
        const open = needle !== "" || (opened[group.sessionId] ?? group.isCurrent);
        return (
          <div className="panel-output" key={group.sessionId}>
            <button
              aria-expanded={open}
              className={`panel-output-head${group.isCurrent ? " is-current" : ""}${open ? " is-open" : ""}`}
              onClick={() => setOpened((current) => ({ ...current, [group.sessionId]: !open }))}
              title={group.title}
              type="button"
            >
              <span aria-hidden="true" className="tree-chev">▸</span>
              <span className="label">{group.title}</span>
              {group.isCurrent ? <span className="label-meta">{TEXT.workspace.currentSession}</span> : null}
            </button>
            {!open ? null : outputs.map((output) => {
              const name = artifactName(output);
              // One row per artifact, keyed by the artifact: its versions are
              // behind the picker beside the document, not rows of their own.
              //
              // The hint is computed over the whole list, not the filtered one,
              // so it does not flicker away while the reader is still typing.
              const hint = hints.get(output.artifact.id) ?? "";
              const isActive = output.artifact.id === activeId;
              return (
                <button
                  className={`panel-list-row${isActive ? " is-active" : ""}`}
                  key={output.artifact.id}
                  onClick={() => void actions.openArtifact(output)}
                  title={output.artifact.description ?? artifactPath(output)}
                  type="button"
                >
                  <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="15">
                    <path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z" />
                    <path d="M14 3.5V8h4" />
                  </svg>
                  <span className="label">{name}</span>
                  {hint === "" ? null : (
                    <span className="label-meta" title={artifactPath(output)}>{hint}</span>
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

function TreeLevel({ actions, activePath, node }: {
  actions: WorkspaceActions;
  activePath?: string;
  node: FileTreeNode;
}) {
  const [folded, setFolded] = useState<Record<string, boolean>>({});
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
                <TreeLevel actions={actions} activePath={activePath} node={child} />
              </div>
            ) : null}
          </div>
        );
      })}
      {node.files.map((file) => (
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

function CheckGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="12">
      <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
    </svg>
  );
}

/**
 * The way back from a closed column.
 *
 * It stays out of sight until the pointer is on the edge, so a closed panel
 * looks as plain as an open one, and the arrow points towards the column it
 * brings back. It is only the drawing: the divider underneath is still the
 * control. A press on the edge is a drag like any other; one that never moved
 * is a click, and a click there restores the default split. Intercepting the
 * press with a button of its own would take the middle of the divider away
 * from the drag, which is exactly where the pointer is when the control shows.
 *
 * Exported because it only exists after a drag, and its markup is the part
 * worth testing.
 */
export function PanelExpand({ side }: { side: "left" | "right" }) {
  return (
    <span aria-hidden="true" className={`panel-expand is-${side}`}>
      <svg fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="14">
        <path d={side === "left" ? "m9 5 7 7-7 7" : "m15 5-7 7 7 7"} />
      </svg>
    </span>
  );
}

/**
 * The versions of the open artifact, as a card rather than the platform's own
 * menu: a native select draws a square popup in the system's highlight colour
 * in the middle of the panel's quiet chrome. Exported because the menu exists
 * only while it is open, and its rows are the part worth testing.
 */
export function VersionMenu({
  current,
  onSelect,
  versions,
}: {
  current?: string;
  onSelect: (version: SessionArtifactOutput) => void;
  versions: SessionArtifactOutput[];
}) {
  return (
    <div aria-label={TEXT.workspace.version} className="doc-version-menu" role="menu">
      {versions.map((output) => {
        const selected = output.version.id === current;
        return (
          <button
            aria-checked={selected}
            className={`doc-version-option${selected ? " is-current" : ""}`}
            key={output.version.id}
            onClick={() => onSelect(output)}
            role="menuitemradio"
            type="button"
          >
            <span>v{output.version.version}</span>
            {selected ? <CheckGlyph /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** The trigger and its menu. Only rendered when there is more than one version,
 *  so the closed state always has something behind it. */
function VersionPicker({
  current,
  onSelect,
  versions,
}: {
  current?: string;
  onSelect: (version: SessionArtifactOutput) => void;
  versions: SessionArtifactOutput[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const shown = versions.find((output) => output.version.id === current) ?? versions[0];

  useEffect(() => {
    if (!open) return;
    // A click anywhere else closes the menu, the way the composer's own menus
    // do. Escape closes it and hands focus back to the trigger, since the menu
    // it was in is gone.
    const dismiss = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <span className="doc-versions" ref={root}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={shown === undefined
          ? TEXT.workspace.version
          : `${TEXT.workspace.version} v${shown.version.version}`}
        className={`doc-version-button${open ? " is-open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        ref={trigger}
        title={TEXT.workspace.version}
        type="button"
      >
        {shown === undefined ? "" : `v${shown.version.version}`}
        <svg aria-hidden="true" fill="none" height="10" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 10 10" width="10">
          <path d="m2.5 4 2.5 2.5L7.5 4" />
        </svg>
      </button>
      {open ? (
        <VersionMenu
          current={shown?.version.id}
          onSelect={(version) => {
            setOpen(false);
            // The menu unmounts with the pick, and focus would land on the
            // body; the trigger is what the reader is looking at now.
            trigger.current?.focus();
            onSelect(version);
          }}
          versions={versions}
        />
      ) : null}
    </span>
  );
}

/**
 * The right column: 产物 and 工作区.
 *
 * Both groups keep a 240px list on the left and open the selected document in
 * tabs on the right. A document belongs to the group it was opened from, so
 * switching groups does not show an artifact under the workspace tab. 任务 is
 * not a tab: the run's progress is already the conversation, and a second list
 * of the same tool calls said nothing new.
 */
export function WorkspacePanel({
  actions,
  activeGroup,
  files,
  onCloseDetail,
  onCollapse,
  onSelectGroup,
  outputs,
  resize,
  sessionId,
  sessions = [],
  subagent,
  subagentLoading,
  tool,
  tabs,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [artifactQuery, setArtifactQuery] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const activeTab = useRef<HTMLDivElement>(null);

  const docs = tabs.tabs.filter((slot) => !slot.home && slot.source === (activeGroup === "files" ? "file" : "artifact"));
  const active = tabs.tabs.find((slot) => slot.id === tabs.activeTabId && docs.includes(slot));
  // The list shows every Session's artifacts, grouped by the Session that made
  // them, with the open Session's group first. The versions of the artifact on
  // screen are the picker's business, and it is the newest version that has a
  // row — whichever Session wrote it.
  const artifactSections = artifactGroups(outputs, sessions, sessionId, TEXT.workspace.untitledSession);
  const artifacts = artifactSections.flatMap((group) => group.outputs);
  // The picker reaches versions written by any Session, so it reads the union
  // rather than the group a row happens to sit under.
  const allVersions = artifactSections.flatMap((group) => group.versions);
  const activeArtifact = active?.artifactId === undefined
    ? undefined
    : outputs.find((output) => output.artifact.id === active.artifactId);
  const activeVersions = active?.artifactId === undefined ? [] : versionsOf(allVersions, active.artifactId);

  // The list column and the document column share the panel, and the divider
  // between them is the reader's: drag it left and the list goes, drag it right
  // and the document does. See `panel-split` for where each one snaps closed.
  const splitBody = useRef<HTMLDivElement>(null);
  const panel = usePanelSplit(splitBody);
  const listClosed = isListClosed(panel.split);
  const closed = listClosed || panel.split.docClosed;
  // A click on a row is a request to see the document, and a closed document
  // column would swallow it: opening anything brings the column back.
  const listActions: WorkspaceActions = {
    ...actions,
    openArtifact: (output) => {
      panel.openDoc();
      return actions.openArtifact(output);
    },
    openFile: (file) => {
      panel.openDoc();
      return actions.openFile(file);
    },
  };
  // What the list actually gets: the panel can be narrowed after the divider
  // was moved, and the document column keeps its minimum — otherwise the reader
  // would lose the page with nothing marked closed and no edge to click.
  const listPx = panel.width > 0 ? listWidth(panel.split, panel.width) : panel.split.list;
  // The separator reports the same measured body the drag uses, so its value
  // never sits outside its own range when the panel is narrower than the drag.
  // Before the first measurement it falls back to the panel's own width.
  const bodyWidth = panel.width > 0 ? panel.width : resize.width;
  const listMax = Math.max(LIST_MIN_WIDTH, Math.round(bodyWidth) - DOC_MIN_WIDTH);
  const splitter = (
    <div
      aria-label={closed ? TEXT.workspace.expand : TEXT.workspace.resizeList}
      aria-orientation="vertical"
      aria-valuemax={listMax}
      aria-valuemin={0}
      aria-valuenow={listClosed ? 0 : Math.min(listPx, listMax)}
      className="panel-splitter"
      onKeyDown={(event) => {
        if (closed && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          panel.reset();
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        panel.nudge(event.key === "ArrowLeft" ? -LIST_NUDGE_STEP : LIST_NUDGE_STEP);
      }}
      onPointerDown={panel.start}
      role="separator"
      tabIndex={0}
    >
      {/* A closed column leaves no border behind to say the divider is there,
          so the edge offers a way back instead: the control is invisible until
          the pointer reaches the divider, then one click restores the default
          split. It sits inside the divider rather than over it, so its press
          still reaches the drag — and its cursor is the pointer's, since a
          click is what it is for. */}
      {listClosed ? <PanelExpand side="left" /> : null}
      {panel.split.docClosed ? <PanelExpand side="right" /> : null}
    </div>
  );

  useEffect(() => {
    setExpanded(false);
  }, [tabs.activeTabId]);

  // Opening a document has to show the tab it landed in. In a narrow panel the
  // strip scrolls, and a new tab past the right edge would otherwise look like
  // the document had been swapped into the tab already on screen.
  useEffect(() => {
    activeTab.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tabs.activeTabId]);

  const activeName = active === undefined ? "" : previewName(active.label, active.path);
  const structure =
    active !== undefined
    && !active.loading
    && detectStructureFormat({ content: active.content ?? "", name: activeName }) !== undefined;
  // Two tabs can carry the same label — two artifacts that share a file name,
  // or a file and an artifact with the same name. Only then is there a second
  // fact worth showing; a unique label keeps the whole tab for itself.
  const hints = artifactHints(artifacts);
  const labelCounts = new Map<string, number>();
  for (const slot of docs) labelCounts.set(slot.label, (labelCounts.get(slot.label) ?? 0) + 1);
  const tabHint = (slot: PreviewSlot): string => {
    if ((labelCounts.get(slot.label) ?? 0) < 2) return "";
    // An artifact's note comes from the list it was opened from; a source file
    // has only its folder to offer. A version is not a note here any more —
    // one tab holds one artifact, and its version has a picker of its own.
    const note = slot.artifactId === undefined ? undefined : hints.get(slot.artifactId);
    return note ?? fileFolder(slot.path);
  };
  const tabTitle = (slot: PreviewSlot): string => (slot.path === "" ? slot.label : slot.path);
  // A search narrows the tree to the files that match and the folders above
  // them; `undefined` means nothing matched, which the column says outright
  // rather than drawing folders that hold no result.
  const shownTree = filterFileTree(buildFileTree(files), fileQuery);

  const groups: { id: PanelGroup; label: string }[] = [
    { id: "artifacts", label: TEXT.workspace.groups.artifacts },
    { id: "files", label: TEXT.workspace.groups.files },
  ];
  const subagentDescription = subagent === undefined ? "" : subagentTask(subagent);

  const docArea = (
    <div className="panel-doc">
      {docs.length === 0 ? (
        <div className="doc-placeholder">
          <span aria-hidden="true" className="mark">
            <GroupIcon group={activeGroup} />
          </span>
          <span>{activeGroup === "artifacts" ? TEXT.workspace.unopenedArtifacts : TEXT.workspace.unopenedFiles}</span>
        </div>
      ) : (
        <>
          {/* The strip and its actions share a row; the strips must not be the
              same element, or the tablist inherits the 46px height rule as a
              width and clips every tab but the first. */}
          <div className="doc-tabbar">
            <div className="doc-tabs" role="tablist">
              {docs.map((slot) => {
                const isActive = slot.id === tabs.activeTabId;
                const hint = tabHint(slot);
                return (
                  <div
                    className={`doc-tab${isActive ? " is-active" : ""}`}
                    key={slot.id}
                    ref={isActive ? activeTab : undefined}
                    role="presentation"
                  >
                    <button
                      aria-selected={isActive}
                      className="doc-tab-label"
                      onClick={() => actions.selectPanelTab(slot.id)}
                      role="tab"
                      title={tabTitle(slot)}
                      type="button"
                    >
                      <span className="doc-tab-name">{slot.label}</span>
                      {hint === "" ? null : <span className="doc-tab-hint">{hint}</span>}
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
                      {/* A glyph's own bearings cannot be centred by a box, so
                          the ✕ is drawn: it is the same distance from all four
                          edges of the 18px hover square. */}
                      <svg aria-hidden="true" fill="none" height="10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" viewBox="0 0 10 10" width="10">
                        <path d="M2 2l6 6M8 2 2 8" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="doc-tabs-actions">
              {/* The version of the open artifact, in the document's own top
                  right. One version is not a choice, so it gets no picker. */}
              {active !== undefined && activeVersions.length > 1 ? (
                <VersionPicker
                  current={active.versionId}
                  // Keyed by the open document: a menu left open belongs to the
                  // document it was opened on, not to whatever replaces it.
                  key={active.id}
                  onSelect={(output) => void actions.selectArtifactVersion(active.id, output)}
                  versions={activeVersions}
                />
              ) : null}
              {active !== undefined ? (
                <button
                  aria-label={TEXT.workspace.download}
                  className="panel-icon-button"
                  onClick={() => downloadDocument(active, activeArtifact)}
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
              <DocumentPreview expanded={expanded} onExpand={setExpanded} slot={active} />
            ) : (
              <div className="artifact-canvas">
                <DocumentPreview expanded={expanded} onExpand={setExpanded} slot={active} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <aside className="workspace-panel" data-guide="panel">
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
      <header className={`panel-head${subagent === undefined && tool === undefined ? "" : " is-subagent"}`}>
        {/* A child's record and a tool's text are modes of the panel, not tabs
            beside 产物 and 工作区, so the way back has to be drawn here. The
            line that opened it is in the transcript, which the reader is no
            longer looking at. */}
        {subagent === undefined && tool === undefined ? null : (
          <button
            aria-label={TEXT.workspace.backToGroups}
            className="panel-icon-button panel-back"
            onClick={onCloseDetail}
            title={TEXT.workspace.backToGroups}
            type="button"
          >
            <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="15">
              <path d="M14.5 5.5 8 12l6.5 6.5" />
            </svg>
          </button>
        )}
        {tool !== undefined ? (
          <div className="panel-subagent-title" title={tool.name}>
            <span className="panel-subagent-label">{TEXT.conversation.toolCall}</span>
            <span className="panel-subagent-text">{tool.name}</span>
          </div>
        ) : subagent === undefined ? (
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
        ) : (
          <div className="panel-subagent-title" title={subagentDescription}>
            <span className="panel-subagent-label">{TEXT.subagent.lineLabel}</span>
            <span className="panel-subagent-text">{subagentDescription}</span>
          </div>
        )}
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

      {tool !== undefined ? (
        <div className="panel-body is-tool">
          <ToolDetail detail={tool} />
        </div>
      ) : subagent === undefined ? (
        <div
          className={`panel-body${panel.split.docClosed ? " is-doc-closed" : ""}${listClosed ? " is-list-closed" : ""}`}
          ref={splitBody}
          style={{ "--panel-list-width": `${listPx}px` } as CSSProperties}
        >
          {activeGroup === "artifacts" ? (
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
                  actions={listActions}
                  activeId={active?.artifactId}
                  groups={artifactSections}
                  hints={hints}
                  query={artifactQuery}
                />
              </div>
              {splitter}
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
                ) : shownTree === undefined ? (
                  <div className="panel-empty">{TEXT.workspace.searchEmpty}</div>
                ) : (
                  <TreeLevel actions={listActions} activePath={active?.path} node={shownTree} />
                )}
              </div>
              {splitter}
              {docArea}
            </>
          )}
        </div>
      ) : (
        <div className="panel-body is-subagent">
          <SubagentDetail loading={subagentLoading ?? false} subagent={subagent} />
        </div>
      )}
    </aside>
  );
}
