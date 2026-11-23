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

/**
 * 设置 › 会话管理: the Sessions that left 活跃 by being archived.
 *
 * The sidebar holds active Sessions only, so this page is where an archived one
 * is found again. It is a listing, not a second sidebar: a row opens the
 * Session read-only, 恢复 sends it back to 活跃 — from where the conversation
 * carries on — and 彻底删除 is the one irreversible action, so it goes through
 * the same confirmation dialog as the ⋯ menu's delete.
 *
 * The page reads its own listing: `listSessions` is per Project, and 活跃 is a
 * server-side state, so nothing here can be derived from the workspace state
 * the sidebar already holds. Every mutation goes through the workspace actions,
 * which refresh the sidebar's own lists, and then reloads this one.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ApiClient } from "../../../api/client.js";
import { listSessions } from "../../../api/sessions.js";
import type { Project, Session } from "../../../api/types.js";
import { sessionTitle } from "../../../app/session-title.js";
import type { WorkspaceActions } from "../../../app/use-workspace.js";
import { TEXT } from "../../../text.js";
import "../../../styles/export-history.css";
import "../../../styles/session-management.css";

/** One archived Session, with the Project whose name the row shows. */
export interface ArchivedRow {
  project: Project;
  session: Session;
}

/** Local time for an archive stamp, or the raw one when it cannot be parsed. */
function formatArchivedAt(stamp: string, locale: string): string {
  const at = Date.parse(stamp);
  if (Number.isNaN(at)) return stamp;
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(at));
}

/**
 * The rows themselves, without the reading: the settings page owns the load and
 * the mutations, and this part is what a render test can drive.
 */
export function ArchivedSessionList({
  onOpen,
  onRemove,
  onRestore,
  rows,
}: {
  onOpen: (session: Session) => void;
  onRemove: (session: Session) => void;
  onRestore: (session: Session) => void;
  rows: ArchivedRow[];
}) {
  const t = TEXT.sessionManagement;
  return (
    <ul className="session-management">
      {rows.map((row) => (
        <li className="session-management-row" key={row.session.id}>
          <span aria-hidden="true" className="session-management-glyph">
            {/* The archive box the ⋯ menu draws, so the two read as one action. */}
            <svg fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" viewBox="0 0 24 24" width="16">
              <rect height="4" rx="1" width="18" x="3" y="4" />
              <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
              <path d="M10 12h4" />
            </svg>
          </span>
          <span className="session-management-main">
            <span className="session-management-name" title={sessionTitle(row.session.title)}>
              {sessionTitle(row.session.title)}
            </span>
            <span className="session-management-meta">
              <span className="session-management-project" title={row.project.name}>{row.project.name}</span>
              {row.session.archivedAt ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{t.archivedAt(formatArchivedAt(row.session.archivedAt, TEXT.languageTag))}</span>
                </>
              ) : null}
            </span>
            <span className="session-management-hint">{t.readOnly}</span>
          </span>
          <span className="session-management-actions">
            <button className="session-management-button" onClick={() => onOpen(row.session)} type="button">
              {t.open}
            </button>
            <button className="session-management-button" onClick={() => onRestore(row.session)} type="button">
              {t.restore}
            </button>
            <button
              className="session-management-button is-destructive"
              onClick={() => onRemove(row.session)}
              type="button"
            >
              {t.remove}
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SessionManagementSettings({
  actions,
  client,
  inbox,
  onClose,
  projects,
}: {
  actions: WorkspaceActions;
  client: ApiClient;
  /** The Session outside every Project. It is the one a first conversation lands
   *  in, and the server leaves it out of `GET /api/projects`, so the page has to
   *  be handed it or a Session archived from 会话 would have no row here. */
  inbox?: Project;
  /** Opening a row leaves settings: the conversation is behind this surface. */
  onClose: () => void;
  projects: Project[];
}) {
  const t = TEXT.sessionManagement;
  const [rows, setRows] = useState<ArchivedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("all");

  // The workspace hands over a fresh `projects` array after every listing read,
  // so an effect keyed on that identity re-read every Project on every refresh
  // and blanked the rows while it did. The latest arrays are kept here and the
  // read depends on a key that changes only when the set of Projects does — a
  // rename still reaches the rows, because the read looks at this ref.
  const latest = useRef({ inbox, projects });
  latest.current = { inbox, projects };
  const scopeKey = `${projects.map((entry) => entry.id).join(",")}|${inbox?.id ?? ""}|${project}`;

  /**
   * Reads the archived set of the Projects in scope, the inbox included. A
   * Project whose listing fails is left out rather than failing the page — one
   * unreachable Project must not hide the others — but the failure is reported,
   * because "nothing is archived" and "nothing could be read" are different
   * answers and the empty state must not stand for both.
   */
  const read = useCallback(async (): Promise<{ failed: boolean; rows: ArchivedRow[] }> => {
    const { inbox: currentInbox, projects: currentProjects } = latest.current;
    const all = currentInbox ? [...currentProjects, currentInbox] : currentProjects;
    const scoped = project === "all" ? all : all.filter((entry) => entry.id === project);
    let failed = false;
    const lists = await Promise.all(
      scoped.map(async (entry) => {
        try {
          const sessions = await listSessions(client, entry.id, "archived");
          return sessions.map((session) => ({ project: entry, session }));
        } catch {
          failed = true;
          return [];
        }
      }),
    );
    // Newest archive first: the Session put away a minute ago is the one a
    // user most often comes here to bring back.
    const rows = lists.flat().sort((left, right) => (right.session.archivedAt ?? "").localeCompare(left.session.archivedAt ?? ""));
    return { failed, rows };
  }, [client, project, scopeKey]);

  const [reloads, setReloads] = useState(0);
  const [failed, setFailed] = useState(false);
  /** The scope the rows on screen belong to. Only the first read of a scope
   *  blanks them with 读取中: another Project's archived Sessions must never be
   *  drawn under this one's heading while its read is in flight. */
  const loadedScope = useRef<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    if (loadedScope.current !== scopeKey) {
      setLoading(true);
      setRows([]);
    }
    void read().then((next) => {
      if (!live) return;
      loadedScope.current = scopeKey;
      setRows(next.rows);
      setFailed(next.failed);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [read, reloads]);

  const reload = useCallback(() => setReloads((count) => count + 1), []);

  const needle = query.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (!needle) return true;
    return sessionTitle(row.session.title).toLowerCase().includes(needle)
      || row.project.name.toLowerCase().includes(needle);
  });

  const restore = async (session: Session) => {
    await actions.restoreSession(session);
    reload();
  };

  // The confirmation and the delete belong to the workspace, so the ⋯ menu and
  // this page cannot drift apart; `onSettled` is what redraws this listing once
  // the server has answered.
  const remove = (session: Session) => actions.deleteSession(session, reload);

  const open = async (session: Session) => {
    await actions.openSession(session.id, session.projectId);
    onClose();
  };

  const body = (() => {
    if (loading) return <p className="settings-hint">{t.loading}</p>;
    const unreachable = failed ? <p className="settings-hint is-warning" role="status">{t.unreachable}</p> : null;
    if (visible.length === 0) {
      return (
        <>
          {unreachable}
          <p className="settings-hint">{rows.length === 0 ? t.empty : t.noMatch}</p>
        </>
      );
    }
    return (
      <>
        {unreachable}
        <ArchivedSessionList onOpen={(s) => void open(s)} onRemove={remove} onRestore={(s) => void restore(s)} rows={visible} />
      </>
    );
  })();

  return (
    <section className="session-management-settings">
      {/* The page header already says 会话管理 and what it holds; the toolbar is
          the scope control on the left and the search field on the right, the
          same order 导出记录 uses. */}
      <div className="export-history-filters">
        <select aria-label={t.allProjects} onChange={(event) => setProject(event.target.value)} value={project}>
          <option value="all">{t.allProjects}</option>
          {/* The inbox is a Project here too: it is where a first conversation
              lands, and its archived Sessions have to be scoped like any other. */}
          {(inbox ? [...projects, inbox] : projects).map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.name}</option>
          ))}
        </select>
        <input
          aria-label={t.searchPlaceholder}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.searchPlaceholder}
          type="search"
          value={query}
        />
      </div>
      {body}
    </section>
  );
}
