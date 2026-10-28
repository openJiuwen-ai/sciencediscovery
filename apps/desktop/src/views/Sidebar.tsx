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

import { projectWithName } from "../app/project-name.js";
import type { WorkspaceActions } from "../app/use-workspace.js";
import { byRecency } from "../app/session-order.js";
import { formatStars, REPO_URL, useGithubStars } from "../app/use-github-stars.js";
import type { Project, Session } from "../api/types.js";
import { TEXT } from "../text.js";
import { PromptDialog } from "./PromptDialog.js";
import { RowMenu, type MenuState } from "./RowMenu.js";
import { sessionTitle } from "../app/session-title.js";
import { SidebarToggle } from "./SidebarToggle.js";

interface Renaming {
  session: Session;
  value: string;
}

interface Props {
  actions: WorkspaceActions;
  /** The Project of the open Session, for the fold's highlight. */
  activeProjectId?: string;
  activeSessionId?: string;
  onToggleSidebar?: () => void;
  /** The Projects the user made, oldest first. The inbox is not among them:
   *  its Sessions are the `recent` list, and it gets no fold. */
  projects: Project[];
  /** The Sessions that belong to no Project, newest first. */
  recent: Session[];
  /** Whether the open Session is running a task, which its row shows. */
  running?: boolean;
  sessionsByProject: Record<string, Session[]>;
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
 * The session column: 科研会话, one way in, then two lists that say what a
 * Session belongs to.
 *
 * 项目 comes first — every Project the user made is a fold with its own `+`,
 * which starts a Session inside it. Below it, 最近会话 holds the conversations
 * that belong to no Project: the inbox's Sessions, where the top button and the
 * first message land. That distinction is the point of the screen: a
 * conversation is standalone until someone puts it in a Project, and a Project
 * exists because someone named one. Until now the app invented a single
 * 我的工作区 and filed everything under it, so the column could not say either
 * thing.
 *
 * This column used to end with a 会话 section that held nothing but a running
 * Session, if any. 最近会话 takes its place, and the running Session keeps its
 * spinner on its own row instead of being listed twice.
 */
export function Sidebar({
  actions,
  activeProjectId,
  activeSessionId,
  onToggleSidebar,
  projects,
  recent,
  running,
  sessionsByProject,
}: Props) {
  const [menu, setMenu] = useState<MenuState>();
  const [renaming, setRenaming] = useState<Renaming>();
  const [creating, setCreating] = useState(false);
  /** Folded-up Projects, by id. Empty means every fold is open — the state a
   *  column of two or three Projects should start in — and a Project created
   *  later inherits it without being added anywhere. */
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  /** Which lists have been asked to show past their first page, keyed by the
   *  list (`recent` or a Project id), so one long list does not unfold the
   *  others. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const stars = useGithubStars();

  const anchor = (event: { clientX: number; clientY: number }) => ({
    x: event.clientX,
    y: event.clientY,
  });

  const toggleFold = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const showAll = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });

  const commitRename = (next: Renaming) => {
    const name = next.value.trim();
    setRenaming(undefined);
    // Compared against what the field showed, not what the service stored: an
    // untouched field on an unnamed Session holds 未命名会话, and Enter without
    // an edit is not a rename to that phrase.
    if (name !== "" && name !== sessionTitle(next.session.title)) void actions.renameSession(next.session, name);
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

  const sessionRow = (session: Session) => {
    const active = session.id === activeSessionId;
    const editing = renaming !== undefined && renaming.session.id === session.id;
    return (
      <div className={`side-row side-sub${active ? " is-active" : ""}`} key={session.id}>
        <button
          className="side-session"
          onClick={() => void actions.openSession(session.id, session.projectId)}
          // Double-click is the design's own rename gesture; the `⋯` menu
          // beside the name opens the same field, which keeps it discoverable.
          onDoubleClick={() => setRenaming({ session, value: sessionTitle(session.title) })}
          title={`${basename(session)} · ${TEXT.sidebar.renameHint}`}
          type="button"
        >
          {editing ? renameField(renaming) : <span className="side-session-name">{basename(session)}</span>}
          {/* The run belongs to this Session, not to a section of its own: a
              second row for it would be the same conversation listed twice. */}
          {running && active ? <span aria-hidden="true" className="side-spinner" /> : null}
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
                    onSelect: () => setRenaming({ session, value: sessionTitle(session.title) }),
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

  /** A page of Sessions, then 显示更多 — the rule in every list here, so a
   *  Project with a year of history cannot bury the one below it. */
  const sessionList = (key: string, sessions: readonly Session[]) => {
    const open = expanded.has(key);
    const shown = open ? sessions : sessions.slice(0, PAGE_SIZE);
    return (
      <>
        {shown.map((session) => sessionRow(session))}
        {!open && sessions.length > PAGE_SIZE ? (
          <button className="side-more" onClick={() => showAll(key)} type="button">
            {TEXT.sidebar.showMore}
          </button>
        ) : null}
      </>
    );
  };

  return (
    <aside className="sidebar">
      <div className="side-head">
        <span className="side-title">{TEXT.sidebar.title}</span>
        {onToggleSidebar ? <SidebarToggle onClick={onToggleSidebar} open /> : null}
      </div>

      <button className="side-new" onClick={() => actions.newSession()} type="button">
        <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 24 24" width="16">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>{TEXT.sidebar.newTask}</span>
      </button>

      <div className="side-scroll">
        <div className="side-label side-label-row">
          <span>{TEXT.sidebar.project}</span>
          <button
            aria-label={TEXT.sidebar.newProject}
            className="side-mini-button is-add"
            onClick={() => setCreating(true)}
            title={TEXT.sidebar.newProject}
            type="button"
          >
            +
          </button>
        </div>
        {projects.length === 0 ? <div className="side-empty">{TEXT.sidebar.noProjects}</div> : null}
        {projects.map((project) => {
          const open = !folded.has(project.id);
          const sessions = byRecency(sessionsByProject[project.id] ?? []);
          return (
            <div key={project.id}>
              <div
                className={`side-row side-project${open ? " is-open" : ""}${project.id === activeProjectId ? " is-active" : ""}`}
              >
                <button
                  aria-expanded={open}
                  className="side-project-toggle"
                  onClick={() => toggleFold(project.id)}
                  type="button"
                >
                  <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="15">
                    <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
                  </svg>
                  <span className="label">{project.name}</span>
                  <svg aria-hidden="true" className="chev" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="14">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                <div className="side-actions">
                  <button
                    aria-label={TEXT.sidebar.newSessionInProject(project.name)}
                    className="side-mini-button is-add"
                    onClick={() => actions.newSession(project.id)}
                    title={TEXT.sidebar.newSessionInProject(project.name)}
                    type="button"
                  >
                    +
                  </button>
                </div>
              </div>
              {open
                ? sessions.length === 0
                  ? <div className="side-empty">{TEXT.sidebar.noTasks}</div>
                  : sessionList(project.id, sessions)
                : null}
            </div>
          );
        })}

        {/* The column's own answer to "where will a new conversation go": the
            top button starts one outside any Project, and this is the list it
            lands in. It sits last because it is the fallback, not a place the
            user filed anything. */}
        <div className="side-label side-label-spaced">{TEXT.sidebar.recent}</div>
        {recent.length === 0 ? (
          <div className="side-empty">{TEXT.sidebar.noRecent}</div>
        ) : (
          <div className="side-flat">{sessionList("recent", recent)}</div>
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

      {creating ? (
        <PromptDialog
          accept={TEXT.menu.confirm}
          eyebrow={TEXT.sidebar.project}
          fieldLabel={TEXT.sidebar.projectName}
          onCancel={() => setCreating(false)}
          onSubmit={(name) => {
            setCreating(false);
            void actions.createProject(name);
          }}
          placeholder={TEXT.sidebar.projectName}
          title={TEXT.sidebar.newProject}
          validate={(name) =>
            projectWithName(projects, name) === undefined
              ? undefined
              : TEXT.sidebar.projectNameTaken(name)}
        />
      ) : null}

      <RowMenu menu={menu} onClose={() => setMenu(undefined)} />
    </aside>
  );
}
