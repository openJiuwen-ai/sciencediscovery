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

import { useMemo, useState } from "react";

import type { ApiClient } from "../api/client.js";
import { commitsOnEnter } from "../app/ime-enter.js";
import { projectWithName } from "../app/project-name.js";
import {
  hasActiveFilter,
  readSidebarFilters,
  sessionInWindow,
  sessionMatchesFilters,
  writeSidebarFilters,
  type SidebarFilters,
  type SidebarWindow,
} from "../app/sidebar-filters.js";
import { useSessionFilterFacts } from "../app/use-session-filter.js";
import type { WorkspaceActions } from "../app/use-workspace.js";
import { byRecency, untitled } from "../app/session-order.js";
import { formatStars, REPO_URL, useGithubStars } from "../app/use-github-stars.js";
import { openFeedback } from "../feedback/open.js";
import type { Project, Session } from "../api/types.js";
import { TEXT } from "../text.js";
import { PromptDialog } from "./PromptDialog.js";
import { RowMenu, type MenuState } from "./RowMenu.js";
import { sessionTitle } from "../app/session-title.js";
import { SidebarSearch } from "./SidebarSearch.js";
import { SidebarToggle } from "./SidebarToggle.js";

/** One rename in progress, whichever kind of row it started from. A Project
 *  and a Session both rename from a double-click and from their `⋯` menu, and
 *  only one field is open at a time, so the two share a piece of state. */
type Renaming =
  | { kind: "project"; project: Project; value: string }
  | { kind: "session"; session: Session; value: string };

interface Props {
  actions: WorkspaceActions;
  /** The sidebar calls the workbench search and the two on-demand filter reads
   *  through this: the app's one authenticated client. */
  client: ApiClient;
  onExportSession?: (session: Session) => void;
  onImportSession?: () => void;
  /** The Project of the open Session, for the fold's highlight. */
  activeProjectId?: string;
  activeSessionId?: string;
  /** The inbox Project, whose archived Sessions and artifacts the server's
   *  search skips; passed through to the search panel. */
  inboxProjectId?: string;
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
 * which starts a Session inside it. Below it, 会话 holds the conversations
 * that belong to no Project: the inbox's Sessions, where the top button and the
 * first message land. That distinction is the point of the screen: a
 * conversation is standalone until someone puts it in a Project, and a Project
 * exists because someone named one. Until now the app invented a single
 * 我的工作区 and filed everything under it, so the column could not say either
 * thing.
 *
 * This column used to end with a 会话 section that held nothing but a running
 * Session, if any. 会话 takes its place, and the running Session keeps its
 * spinner on its own row instead of being listed twice.
 */
export function Sidebar({
  actions,
  client,
  onExportSession,
  onImportSession,
  activeProjectId,
  activeSessionId,
  inboxProjectId,
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
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SidebarFilters>(() => readSidebarFilters());
  /** A manual retry for a failed on-demand fact read. */
  const [factsAttempt, setFactsAttempt] = useState(0);
  const stars = useGithubStars();
  const searching = query.trim() !== "";

  /** Every loaded Session, which is what the filters read. `recent` and the
   *  Project lists overlap for a Session already moved into a Project, so the
   *  ids are deduplicated before the on-demand reads. */
  const allSessions = useMemo(() => {
    const seen = new Set<string>();
    const list: Session[] = [];
    for (const session of [...recent, ...Object.values(sessionsByProject).flat()]) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      list.push(session);
    }
    return list;
  }, [recent, sessionsByProject]);
  /** Only the rows the cheap filters leave can need a per-Session read, so an
   *  enabled 仅运行中 / 有产物 does not ask about Sessions the other filters
   *  have already hidden. */
  const filterCandidates = useMemo(
    () => allSessions.filter((session) => {
      if (filters.onlyCurrentProject && activeProjectId !== undefined
        && session.projectId !== activeProjectId) return false;
      return sessionInWindow(session, filters.window);
    }),
    [activeProjectId, allSessions, filters.onlyCurrentProject, filters.window],
  );
  // `running` flips when the open run ends, which must re-read the facts even
  // if the Session rows themselves have not changed yet.
  const sessionFacts = useSessionFilterFacts(
    client,
    filterCandidates,
    filters,
    `${running === true ? "running" : "idle"}:${factsAttempt}`,
  );

  const changeFilters = (patch: Partial<SidebarFilters>) => {
    setFilters((current) => {
      const next = { ...current, ...patch };
      writeSidebarFilters(next);
      return next;
    });
  };
  const resetFilters = () => changeFilters({ hasArtifacts: false, onlyCurrentProject: false, onlyRunning: false, window: "all" });

  const sessionVisible = (session: Session): boolean => sessionMatchesFilters(session, filters, {
    activeProjectId,
    running: sessionFacts.running,
    withArtifacts: sessionFacts.withArtifacts,
  });
  const visibleRecent = recent.filter(sessionVisible);
  /** A filter whose facts are still loading is not an empty result set. */
  const filteredEmpty = sessionFacts.pending
    ? TEXT.search.filters.pendingRows
    : sessionFacts.failed
      ? TEXT.search.filters.unavailable
      : TEXT.search.filters.empty;

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
    if (name === "") return;
    if (next.kind === "project") {
      // A Project's name is shown exactly as stored, so the comparison is
      // against the row the reader is looking at.
      if (name !== next.project.name) void actions.renameProject(next.project, name);
      return;
    }
    // The sentinel is the service's name for "nobody has named this". Storing
    // it as a Session's name would make a conversation the column and 会话
    // are built not to list: the row would leave the sidebar while its
    // messages stayed. 未命名会话 is what the field shows for an unnamed
    // Session, and Enter on that text is not a rename to it either.
    if (untitled(name)) return;
    // Compared against what the field showed, not what the service stored: an
    // untouched field on an unnamed Session holds 未命名会话, and Enter without
    // an edit is not a rename to that phrase.
    if (name !== sessionTitle(next.session.title)) void actions.renameSession(next.session, name);
  };

  /** The field is the same for both rows; only the value being edited differs. */
  const editValue = (value: string) =>
    setRenaming((current) => (current === undefined ? current : { ...current, value }));

  const renameField = (next: Renaming) => (
    <input
      autoFocus
      className="side-rename-input"
      onBlur={() => commitRename(next)}
      onChange={(event) => editValue(event.target.value)}
      onKeyDown={(event) => {
        if (commitsOnEnter(event)) commitRename(next);
        if (event.key === "Escape") setRenaming(undefined);
      }}
      value={next.value}
    />
  );

  const sessionRow = (session: Session) => {
    const active = session.id === activeSessionId;
    const editing = renaming?.kind === "session" && renaming.session.id === session.id;
    return (
      <div className={`side-row side-sub${active ? " is-active" : ""}`} key={session.id}>
        <button
          className="side-session"
          onClick={() => void actions.openSession(session.id, session.projectId)}
          // Double-click is the design's own rename gesture; the `⋯` menu
          // beside the name opens the same field, which keeps it discoverable.
          onDoubleClick={() => setRenaming({ kind: "session", session, value: sessionTitle(session.title) })}
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
                    onSelect: () => setRenaming({ kind: "session", session, value: sessionTitle(session.title) }),
                  },
                  ...(onExportSession ? [{ icon: <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" /></svg>, label: TEXT.researchPackage.export, onSelect: () => onExportSession(session) }] : []),
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

      <div className="side-new-split"><button className="side-new" onClick={() => actions.newSession()} type="button">
        <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 24 24" width="16">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>{TEXT.sidebar.newTask}</span>
      </button>
      </div>
      <button className="side-new side-import-button" onClick={() => onImportSession?.()} type="button">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h12v4M4 4v16h12v-4M9 12h11m-4-4 4 4-4 4" /></svg><span>{TEXT.researchPackage.import}</span>
      </button>

      <SidebarSearch
        client={client}
        inboxProjectId={inboxProjectId}
        onOpenArtifact={(artifactId, sessionId) => void actions.openArtifactResult(artifactId, sessionId)}
        onOpenProject={(projectId) => {
          // Opening a Project result unfolds its fold and points the next
          // conversation at it; it does not create a Session.
          setFolded((current) => {
            if (!current.has(projectId)) return current;
            const next = new Set(current);
            next.delete(projectId);
            return next;
          });
          actions.selectProject(projectId);
        }}
        onOpenSession={(sessionId, projectId) => void actions.openSession(sessionId, projectId)}
        onQueryChange={setQuery}
        query={query}
        recent={recent}
      />

      {searching ? null : (
        <>
          <div aria-label={TEXT.search.filters.label} className="side-filters" role="group">
            <span className="side-filters-label">{TEXT.search.filters.label}</span>
            <button
              aria-pressed={filters.onlyCurrentProject}
              className={`side-filter${filters.onlyCurrentProject ? " is-on" : ""}`}
              onClick={() => changeFilters({ onlyCurrentProject: !filters.onlyCurrentProject })}
              type="button"
            >
              {TEXT.search.filters.onlyCurrentProject}
            </button>
            <button
              aria-pressed={filters.onlyRunning}
              className={`side-filter${filters.onlyRunning ? " is-on" : ""}`}
              onClick={() => changeFilters({ onlyRunning: !filters.onlyRunning })}
              type="button"
            >
              {TEXT.search.filters.onlyRunning}
            </button>
            <button
              aria-pressed={filters.hasArtifacts}
              className={`side-filter${filters.hasArtifacts ? " is-on" : ""}`}
              onClick={() => changeFilters({ hasArtifacts: !filters.hasArtifacts })}
              type="button"
            >
              {TEXT.search.filters.hasArtifacts}
            </button>
            <select
              aria-label={TEXT.search.filters.timeWindow}
              className="side-filter-select"
              onChange={(event) => changeFilters({ window: event.target.value as SidebarWindow })}
              value={filters.window}
            >
              <option value="all">{TEXT.search.filters.timeAll}</option>
              <option value="today">{TEXT.search.filters.timeToday}</option>
              <option value="week">{TEXT.search.filters.timeWeek}</option>
            </select>
            {hasActiveFilter(filters) ? (
              <button className="side-filter-reset" onClick={resetFilters} type="button">
                {TEXT.search.filters.reset}
              </button>
            ) : null}
          </div>
          {sessionFacts.pending ? (
            <div className="side-filters-pending" role="status">{TEXT.search.filters.pending}</div>
          ) : null}
          {sessionFacts.failed ? (
            <div className="side-filters-failed" role="status">
              <span>{TEXT.search.filters.failed}</span>
              <button
                className="side-filter-retry"
                onClick={() => setFactsAttempt((current) => current + 1)}
                type="button"
              >
                {TEXT.search.filters.retry}
              </button>
            </div>
          ) : null}
        </>
      )}

      {/* Kept mounted while the results show: `hidden` takes it out of the
          layout but keeps the scroll position Escape returns to. */}
      <div className="side-scroll" hidden={searching}>
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
          const visibleSessions = sessions.filter(sessionVisible);
          const editing = renaming?.kind === "project" && renaming.project.id === project.id;
          return (
            <div key={project.id}>
              <div
                className={`side-row side-project${open ? " is-open" : ""}${project.id === activeProjectId ? " is-active" : ""}`}
              >
                {editing ? (
                  <div className="side-project-toggle">{renameField(renaming)}</div>
                ) : (
                  <button
                    aria-expanded={open}
                    className="side-project-toggle"
                    onClick={() => toggleFold(project.id)}
                    // The same gesture a Session has: a Project's name is the
                    // one piece of it the user chose, and the `⋯` menu opens the
                    // same field for anyone who does not guess double-click.
                    onDoubleClick={() => setRenaming({ kind: "project", project, value: project.name })}
                    title={`${project.name} · ${TEXT.sidebar.renameHint}`}
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
                )}
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
                  <button
                    aria-label={TEXT.sidebar.projectMenu}
                    className="side-mini-button"
                    onClick={(event) =>
                      setMenu({
                        ...anchor(event),
                        items: [
                          {
                            icon: "✎",
                            label: TEXT.menu.rename,
                            onSelect: () => setRenaming({ kind: "project", project, value: project.name }),
                          },
                          {
                            icon: "🗑",
                            label: TEXT.menu.delete,
                            onSelect: () => actions.deleteProject(project),
                          },
                        ],
                      })
                    }
                    title={TEXT.sidebar.projectMenu}
                    type="button"
                  >
                    ⋯
                  </button>
                </div>
              </div>
              {open
                ? sessions.length === 0
                  ? <div className="side-empty">{TEXT.sidebar.noTasks}</div>
                  : visibleSessions.length === 0
                    ? <div className="side-empty">{filteredEmpty}</div>
                    : sessionList(project.id, visibleSessions)
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
        ) : visibleRecent.length === 0 ? (
          <div className="side-empty">{filteredEmpty}</div>
        ) : (
          <div className="side-flat">{sessionList("recent", visibleRecent)}</div>
        )}
      </div>

      {/* The repository's star count and the feedback entry share the column's
          bottom corner, in that order: the star is the fixed souvenir, the
          feedback entry sits to its right. */}
      <div className="side-footer-row">
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
        <button
          aria-label={TEXT.feedback.entry}
          className="side-feedback"
          onClick={() => openFeedback()}
          title={TEXT.feedback.entry}
          type="button"
        >
          <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="16">
            <path d="M4 6h16v10H8l-4 4z" />
          </svg>
          <span>{TEXT.feedback.entry}</span>
        </button>
      </div>

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
