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

import type { WorkspaceActions } from "../app/use-workspace.js";
import { formatStars, REPO_URL, useGithubStars } from "../app/use-github-stars.js";
import type { Session } from "../api/types.js";
import { TEXT } from "../text.js";
import { RowMenu, type MenuState } from "./RowMenu.js";
import { sessionTitle } from "./session-title.js";
import { SidebarToggle } from "./SidebarToggle.js";

interface Renaming {
  id: string;
  value: string;
}

interface Props {
  actions: WorkspaceActions;
  activeSessionId?: string;
  onToggleSidebar?: () => void;
  projectName: string;
  recent: Session[];
  /** The task the open session is running, if it is running one. */
  taskTitle?: string;
  running?: boolean;
}

function basename(session: Session): string {
  return sessionTitle(session.title);
}

/** The handoff's relative stamp: 15:46 today, then 1天前, 3天前, 1周前. */
function stamp(session: Session): string {
  const raw = session.updatedAt ?? session.createdAt;
  const time = Date.parse(raw);
  if (Number.isNaN(time)) return "";
  const now = Date.now();
  const minutes = Math.round((now - time) / 60000);
  if (minutes < 60) return new Date(time).toLocaleTimeString(TEXT.languageTag, { hour: "2-digit", minute: "2-digit" });
  const days = Math.floor(minutes / 60 / 24);
  if (days < 1) return new Date(time).toLocaleTimeString(TEXT.languageTag, { hour: "2-digit", minute: "2-digit" });
  if (days < 7) return TEXT.workspace.daysAgo(days);
  return TEXT.workspace.weeksAgo(Math.floor(days / 7));
}

const PAGE_SIZE = 6;

/**
 * The task column: 科研任务, the two ways in, and the sessions under the one
 * Project this app creates for itself.
 *
 * Two sections, as the handoff draws them: the project's sessions, then the
 * tasks those sessions queued. This product has no separate task queue, so the
 * second section says 暂无任务 unless a run is going — a task is the run, and
 * pretending otherwise would invent a second object to keep in step.
 */
export function Sidebar({
  actions,
  activeSessionId,
  onToggleSidebar,
  projectName,
  recent,
  running,
  taskTitle,
}: Props) {
  const [menu, setMenu] = useState<MenuState>();
  const [renaming, setRenaming] = useState<Renaming>();
  const [projectOpen, setProjectOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const stars = useGithubStars();

  const anchor = (event: { clientX: number; clientY: number }) => ({
    x: event.clientX,
    y: event.clientY,
  });

  const commitRename = (next: Renaming) => {
    const name = next.value.trim();
    setRenaming(undefined);
    const session = recent.find((candidate) => candidate.id === next.id);
    if (session && name !== "" && name !== session.title) void actions.renameSession(session, name);
  };

  const renameField = (next: Renaming) => (
    <input
      autoFocus
      className="side-rename-input"
      onBlur={() => commitRename(next)}
      onChange={(event) => setRenaming({ ...next, value: event.target.value })}
      onKeyDown={(event) => {
        if (event.key === "Enter") commitRename(next);
        if (event.key === "Escape") setRenaming(undefined);
      }}
      value={next.value}
    />
  );

  const needle = query.trim().toLowerCase();
  const visible = needle === ""
    ? recent
    : recent.filter((session) => basename(session).toLowerCase().includes(needle));
  const shown = expanded || needle !== "" ? visible : visible.slice(0, PAGE_SIZE);

  const sessionRow = (session: Session) => {
    const active = session.id === activeSessionId;
    const editing = renaming !== undefined && renaming.id === session.id;
    return (
      <div className={`side-row side-sub${active ? " is-active" : ""}`} key={session.id}>
        <button
          className="side-session"
          onClick={() => void actions.openSession(session.id)}
          // Double-click is the design's own rename gesture; the `⋯` menu
          // beside the name opens the same field, which keeps it discoverable.
          onDoubleClick={() => setRenaming({ id: session.id, value: session.title })}
          title={`${basename(session)} · ${TEXT.sidebar.renameHint}`}
          type="button"
        >
          {editing ? renameField(renaming) : <span className="side-session-name">{basename(session)}</span>}
          {editing ? null : <span className="side-session-time">{stamp(session)}</span>}
        </button>
        <div className="side-actions">
          <button
            aria-label={TEXT.sessionBar.sessionMenu}
            className="side-mini-button"
            onClick={(event) =>
              setMenu({
                ...anchor(event),
                items: [
                  {
                    icon: "✎",
                    label: TEXT.menu.rename,
                    onSelect: () => setRenaming({ id: session.id, value: session.title }),
                  },
                  {
                    icon: "🗑",
                    label: TEXT.menu.delete,
                    onSelect: () => void actions.deleteSession(session),
                  },
                ],
              })
            }
            title={TEXT.sessionBar.sessionMenu}
            type="button"
          >
            ⋯
          </button>
        </div>
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="side-head">
        <span className="side-title">{TEXT.sidebar.title}</span>
        {onToggleSidebar ? <SidebarToggle onClick={onToggleSidebar} open /> : null}
      </div>

      <button className="side-new" onClick={actions.newSession} type="button">
        <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 24 24" width="16">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>{TEXT.sidebar.newTask}</span>
      </button>
      <label className="side-search">
        <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 24 24" width="16">
          <circle cx="11" cy="11" r="6.2" />
          <path d="M16 16l4 4" />
        </svg>
        <input
          aria-label={TEXT.sidebar.searchPlaceholder}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={TEXT.sidebar.searchPlaceholder}
          type="search"
          value={query}
        />
      </label>

      <div className="side-label">{TEXT.sidebar.project}</div>
      <div className="side-scroll">
        <div className={`side-row side-project${projectOpen ? " is-open" : ""}`}>
          <button
            aria-expanded={projectOpen}
            className="side-project-toggle"
            onClick={() => setProjectOpen((current) => !current)}
            type="button"
          >
            <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="15">
              <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
            </svg>
            <span className="label">{projectName}</span>
            <svg aria-hidden="true" className="chev" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="14">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
        {projectOpen ? (
          shown.length === 0 && needle !== "" ? (
            <div className="side-empty">{TEXT.sidebar.noMatch}</div>
          ) : (
            shown.map((session) => sessionRow(session))
          )
        ) : null}
        {!expanded && needle === "" && visible.length > PAGE_SIZE ? (
          <button className="side-more" onClick={() => setExpanded(true)} type="button">
            {TEXT.sidebar.showMore}
          </button>
        ) : null}

        <div className="side-label side-label-spaced">{TEXT.sidebar.tasks}</div>
        {running && taskTitle ? (
          <button className="side-row side-task-row" onClick={() => void actions.openSession(activeSessionId ?? "")} type="button">
            <span className="label">{taskTitle}</span>
            <span aria-hidden="true" className="side-spinner" />
          </button>
        ) : (
          <div className="side-empty">{TEXT.sidebar.noTasks}</div>
        )}
      </div>

      {/* The repository's star count, as the handoff draws it: a small pill in
          the column's own bottom corner. It links out, so it is an anchor
          rather than a button. */}
      <a
        aria-label={TEXT.sidebar.githubStar}
        className="side-star"
        href={REPO_URL}
        rel="noreferrer noopener"
        target="_blank"
        title={TEXT.sidebar.githubStar}
      >
        <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
          <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" fill="currentColor" />
        </svg>
        <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.4" viewBox="0 0 24 24" width="15">
          <path d="m12 3.9 2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.6-5 2.6 1-5.6-4.1-4 5.6-.8z" />
        </svg>
        {stars === undefined ? null : <span className="side-star-count">{formatStars(stars)}</span>}
      </a>

      <RowMenu menu={menu} onClose={() => setMenu(undefined)} />
    </aside>
  );
}
