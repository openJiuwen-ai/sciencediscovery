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

import { commitsOnEnter } from "../app/ime-enter.js";
import { projectWithName } from "../app/project-name.js";
import type { WorkspaceActions } from "../app/use-workspace.js";
import { byRecency, untitled } from "../app/session-order.js";
import { formatStars, REPO_URL, useGithubStars } from "../app/use-github-stars.js";
import { openFeedback } from "../feedback/open.js";
import type { Project, Session, WorkbenchSearchResponse, WorkbenchSearchResult } from "../api/types.js";
import { SearchDialog, type SearchKindFilter } from "./SearchDialog.js";
import { TEXT } from "../text.js";
import { PromptDialog } from "./PromptDialog.js";
import { RowMenu, type MenuState } from "./RowMenu.js";
import { sessionTitle } from "../app/session-title.js";
import { SidebarToggle } from "./SidebarToggle.js";

const migrationIcon = new URL("../assets/icons/migration.svg", import.meta.url).href;

/** One rename in progress, whichever kind of row it started from. A Project
 *  and a Session both rename from a double-click and from their `⋯` menu, and
 *  only one field is open at a time, so the two share a piece of state. */
type Renaming =
  | { kind: "project"; project: Project; value: string }
  | { kind: "session"; session: Session; value: string };

interface Props {
  actions: WorkspaceActions;
  /** The field asks the workspace to run `GET /api/search`. The field is drawn
   *  only when this is given: a column rendered without a workspace has nothing
   *  to search. */
  onSearch?: (query: string) => void;
  /** A result was chosen: a Session opens, a Project switches, an artifact opens. */
  onSearchOpen?: (result: WorkbenchSearchResult) => void;
  onExportSession?: (session: Session) => void;
  onImportSession?: () => void;
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
  /** What `GET /api/search` answered for the current query, if anything. */
  searchResults?: WorkbenchSearchResponse;
  /** Why the last search failed, when it did. */
  searchError?: string;
  /** The query the results belong to; the field is controlled from the workspace. */
  searchQuery?: string;
  sessionsByProject: Record<string, Session[]>;
}

/**
 * What the row's menu offers for archiving, and what has to be said before the
 * click.
 *
 * Kept as a function of the Session and the run state rather than inline in the
 * menu, because "an archived Session offers 恢复", "a running one offers
 * neither", and "archiving is not fully undone by 恢复" are the three rules a
 * reviewer will check, and a portal is a poor place to check them.
 */
export function archiveActionFor(
  session: Pick<Session, "archivedAt">,
  running: boolean,
): { disabled: boolean; hint?: string; label: string; note?: string } {
  if (running) return { disabled: true, label: TEXT.menu.archive, note: TEXT.errors.archiveBlockedByRun };
  // Archiving tears the Session's scientific-environment kernels down and drops
  // persistent memory that was not written to disk; 恢复 clears `archivedAt` and
  // nothing else. The confirmation dialog was removed on purpose — archiving is
  // reversible enough to need no gate — so the consequence is a `hint`: shown
  // while the pointer is on 归档, not left sitting in the menu.
  if (session.archivedAt !== undefined) return { disabled: false, label: TEXT.menu.restore };
  return { disabled: false, label: TEXT.menu.archive, hint: TEXT.errors.archiveTearsDownKernel };
}

function basename(session: Session): string {
  return sessionTitle(session.title);
}

/** The local calendar date of an instant, as a whole-day index. Reading the
 *  local components and normalizing them to UTC keeps a DST change from turning
 *  one calendar day into 23 or 25 hours. */
function calendarDay(time: number): number {
  const date = new Date(time);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/** The row's relative stamp: 15:46 today, then 昨天, 1天前, 3天前, 1周前. */
export function stamp(
  session: Pick<Session, "createdAt" | "updatedAt">,
  now = Date.now(),
): string {
  const raw = session.updatedAt ?? session.createdAt;
  const time = Date.parse(raw);
  if (Number.isNaN(time)) return "";
  const days = Math.round((calendarDay(now) - calendarDay(time)) / 86_400_000);
  // "Today" is the same local calendar date, not "under 24 hours": 22:00
  // yesterday and 15:46 today must not both read as a bare clock time.
  if (days <= 0) return new Date(time).toLocaleTimeString(TEXT.languageTag, { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return TEXT.workspace.yesterday;
  if (days < 7) return TEXT.workspace.daysAgo(days);
  return TEXT.workspace.weeksAgo(Math.floor(days / 7));
}

const PAGE_SIZE = 6;

/**
 * The rows a folded list shows: its first page, plus the open Session when
 * that one sits deeper in the list.
 *
 * The open Session is the row the reader is already using, so folding it away
 * would make the column disagree with the page beside it. It is appended
 * rather than inserted, which leaves the first page in its recency order and
 * never pushes a newer row out to make room.
 */
function foldPage(sessions: readonly Session[], activeSessionId: string | undefined): readonly Session[] {
  const first = sessions.slice(0, PAGE_SIZE);
  if (activeSessionId === undefined || first.some((session) => session.id === activeSessionId)) return first;
  const active = sessions.find((session) => session.id === activeSessionId);
  return active === undefined ? first : [...first, active];
}

/** How many rows a folded list holds back; zero means it fits on one page. */
function hiddenCount(sessions: readonly Session[], activeSessionId: string | undefined): number {
  return sessions.length - foldPage(sessions, activeSessionId).length;
}

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
  onExportSession,
  onImportSession,
  activeProjectId,
  activeSessionId,
  onToggleSidebar,
  projects,
  recent,
  running,
  searchError,
  searchQuery = "",
  searchResults,
  onSearch,
  onSearchOpen,
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
  /** Whether the dialog is open. The column spends no row on search any more:
   *  the magnifier in the title row opens it over the page. */
  const [searchOpen, setSearchOpen] = useState(false);
  /** 全部 groups every hit by kind; a kind shows only that kind. */
  const [searchKind, setSearchKind] = useState<SearchKindFilter>("all");
  /** The magnifier that opened the dialog, so closing it returns the focus. */
  const magnifier = useRef<HTMLButtonElement>(null);

  /** Closing is one gesture wherever it starts — ×, the overlay, Escape: the
   *  query clears and the focus goes back to what opened the dialog. Picking a
   *  hit is not closing, because the app is about to move the reader somewhere. */
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchKind("all");
    onSearch?.("");
    magnifier.current?.focus();
  };

  useEffect(() => {
    // The shortcut is bound to the window, and a renderer that has none (the
    // component tests render on react-test-renderer) has nothing to bind to.
    if (typeof document === "undefined") return;
    // The palette shortcut every editor uses: Cmd+K on macOS, Ctrl+K elsewhere.
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

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
                  // Archiving is reversible — the Session waits in 设置 → 会话管理
                  // and can be restored — so it runs without a confirmation
                  // dialog. What it does *not* give back is a hint on this entry,
                  // shown while the pointer is on it; a run in progress is refused
                  // by the service with a 409, and that one is the menu's `note`,
                  // because it is why the entry is inert.
                  {
                    disabled: archiveActionFor(session, running === true && active).disabled,
                    ...(archiveActionFor(session, running === true && active).hint !== undefined
                      ? { hint: archiveActionFor(session, running === true && active).hint as string }
                      : {}),
                    // A box with its lid, the same "put it away, it can come
                    // back" idea as the 会话管理 page it lands on. Drawn inline
                    // like the export glyph: the design has no icon font.
                    icon: (
                      <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24" width="15">
                        <rect height="4" rx="1" width="18" x="3" y="4" />
                        <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
                        <path d="M10 12h4" />
                      </svg>
                    ),
                    label: archiveActionFor(session, running === true && active).label,
                    onSelect: () => {
                      if (session.archivedAt === undefined) actions.archiveSession(session);
                      else actions.restoreSession(session);
                    },
                  },
                  ...(onExportSession ? [{ icon: <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" /></svg>, label: TEXT.researchPackage.export, onSelect: () => onExportSession(session) }] : []),
                  {
                    icon: "🗑",
                    label: TEXT.menu.delete,
                    onSelect: () => void actions.deleteSession(session),
                  },
                ],
                ...(archiveActionFor(session, running === true && active).note !== undefined
                  ? { note: archiveActionFor(session, running === true && active).note as string }
                  : {}),
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

  /** A page of Sessions, then the number still behind it — the rule in every
   *  list here, so a Project with a year of history cannot bury the one below
   *  it. The control names what pressing it adds, so the cut cannot read as
   *  Sessions that were deleted (Issue #1348). */
  const sessionList = (key: string, sessions: readonly Session[]) => {
    const ordered = byRecency(sessions);
    const shown = expanded.has(key) ? ordered : foldPage(ordered, activeSessionId);
    const hidden = ordered.length - shown.length;
    return (
      <>
        {shown.map((session) => sessionRow(session))}
        {hidden > 0 ? (
          <button className="side-more" onClick={() => showAll(key)} type="button">
            {TEXT.sidebar.showMore(hidden)}
          </button>
        ) : null}
      </>
    );
  };

  return (
    <>
      <aside className="sidebar">
      <div className="side-head">
        <span className="side-title">{TEXT.sidebar.title}</span>
        {onSearch === undefined ? null : (
          <button
            aria-label={TEXT.sidebar.searchLabel}
            className="side-head-button"
            onClick={() => setSearchOpen(true)}
            ref={magnifier}
            title={TEXT.sidebar.searchLabel}
            type="button"
          >
            <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round"
              strokeWidth="1.8" viewBox="0 0 24 24" width="16">
              <circle cx="11" cy="11" r="7" />
              <path d="m16.5 16.5 4 4" />
            </svg>
          </button>
        )}
        {onToggleSidebar ? <SidebarToggle onClick={onToggleSidebar} open /> : null}
      </div>

      <div className="side-new-split"><button className="side-new" onClick={() => actions.newSession()} type="button">
        <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 24 24" width="16">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>{TEXT.sidebar.newTask}</span>
      </button>
        <button className="side-new side-import-button" onClick={() => onImportSession?.()} type="button">
          <img alt="" aria-hidden="true" src={migrationIcon} /><span>{TEXT.researchPackage.import}</span>
        </button>
      </div>

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
          const sessions = sessionsByProject[project.id] ?? [];
          // A folded Project says its own rule above the page, so the size of
          // the cut is visible before the control is pressed. Once expanded
          // there is no rule to state.
          const foldedPage = open && !expanded.has(project.id) && hiddenCount(sessions, activeSessionId) > 0;
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
              {open ? (
                <>
                  {/* The fold's rule sits above the page it describes, on its own
                      line: in the Project row it would squeeze the name on a
                      narrow column each time the row's actions appear. */}
                  {foldedPage ? <div className="side-project-rule">{TEXT.sidebar.pageRule(PAGE_SIZE)}</div> : null}
                  {sessions.length === 0
                    ? <div className="side-empty">{TEXT.sidebar.noTasks}</div>
                    : sessionList(project.id, sessions)}
                </>
              ) : null}
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

      {searchOpen && onSearch !== undefined ? (
        <SearchDialog
          error={searchError}
          kind={searchKind}
          onClose={closeSearch}
          onKind={setSearchKind}
          onPick={(result) => {
            setSearchOpen(false);
            setSearchKind("all");
            onSearchOpen?.(result);
          }}
          onQuery={(query) => {
            onSearch(query);
          }}
          onRetry={() => onSearch(searchQuery.trim())}
          query={searchQuery}
          results={searchResults}
        />
      ) : null}
    </>
  );
}
