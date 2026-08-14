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
 * Bidirectional mapping between the main workbench view and the browser URL.
 *
 * The URL *path* carries the resource identity (which Project/Session, the
 * Usage page, which settings layer); the query string only carries overlay
 * and filter state. Transient UI (menus, search dialog, composer draft,
 * confirmations) is never serialized. Pure functions, no React, so the
 * mapping is unit-testable.
 *
 * Path table (top-level words are reserved: `projects`, `settings`, `usage`;
 * they must never clash with the server-owned `/api`, `/health`, `/assets`):
 * - `/`                                              default landing
 * - `/usage`                                         global Usage page
 * - `/settings/<group>`                              system settings + group
 * - `/projects/<projectId>`                          Project
 * - `/projects/<projectId>/settings`                 Project-scoped settings
 * - `/projects/<projectId>/sessions/<sessionId>`     Session
 * - `/projects/<projectId>/sessions/<sessionId>/settings`  Session-scoped settings
 *
 * When several layers apply at once the settings layer wins the path, then
 * Usage, then Session, then Project.
 *
 * Query keys (only these three):
 * - `filter`    `archived` | `all`: Session list filter (default `active` omitted)
 * - `panel`     `open` | `collapsed`: right-hand workspace panel
 * - `artifact`  workspace-relative path of the open artifact; `/` stays unescaped
 */

export type SettingsKind = "project" | "session" | "system";

export type SessionFilter = "active" | "all" | "archived";

export interface ViewState {
  projectId?: string;
  sessionId?: string;
  /** Session list filter; omitted from the URL when it is the default `active`. */
  sessionFilter?: SessionFilter;
  /** Main-area view; omitted from the URL for the default Session workbench. */
  view?: "usage";
  settingsKind?: SettingsKind;
  /** Only meaningful when `settingsKind === "system"`; validated by the caller. */
  settingsGroup?: string;
  /**
   * Only meaningful when `settingsKind` is `project` or `session`; it mirrors
   * `projectId` / `sessionId` respectively, since the path implies the target.
   */
  settingsTargetId?: string;
  /** Right-hand panel; `undefined` means "fall back to the local preference". */
  workspaceOpen?: boolean;
  artifact?: string;
}

const GROUP_SEGMENT = /^[a-z][a-z0-9-]*$/;

function segments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

export function parseViewState(pathname: string, search: string): ViewState {
  const view: ViewState = {};
  const parts = segments(pathname);
  if (parts.length === 1 && parts[0] === "usage") {
    view.view = "usage";
  } else if (parts.length === 2 && parts[0] === "settings" && parts[1] && GROUP_SEGMENT.test(parts[1])) {
    view.settingsKind = "system";
    view.settingsGroup = parts[1];
  } else if (parts.length >= 2 && parts[0] === "projects" && parts[1]) {
    view.projectId = parts[1];
    if (parts.length === 3 && parts[2] === "settings") {
      view.settingsKind = "project";
      view.settingsTargetId = parts[1];
    } else if (parts.length >= 4 && parts[2] === "sessions" && parts[3]) {
      view.sessionId = parts[3];
      if (parts.length === 5 && parts[4] === "settings") {
        view.settingsKind = "session";
        view.settingsTargetId = parts[3];
      } else if (parts.length > 4) {
        // Unknown trailing segments below a Session: keep the Session itself.
      }
    } else if (parts.length > 2) {
      // Unknown trailing segments below a Project: keep the Project itself.
    }
  }
  // Anything else (unknown top-level word, bare ids, legacy query-only
  // links) leaves the resource fields empty: the app lands on its defaults.

  const params = new URLSearchParams(search);
  const filter = params.get("filter");
  if (filter === "archived" || filter === "all") view.sessionFilter = filter;
  const panel = params.get("panel");
  if (panel === "open") view.workspaceOpen = true;
  else if (panel === "collapsed") view.workspaceOpen = false;
  const artifact = params.get("artifact");
  if (artifact) view.artifact = artifact;
  return view;
}

/** Encode one query value, keeping `/` readable inside workspace paths. */
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, "/");
}

export function serializeViewState(view: ViewState): { pathname: string; search: string } {
  let pathname = "/";
  if (view.settingsKind === "system") {
    pathname = `/settings/${view.settingsGroup ?? "global"}`;
  } else if (view.settingsKind === "project" && (view.settingsTargetId ?? view.projectId)) {
    // The path names the settings *target*, which may differ from the active
    // Project when the dialog was opened from another Project's menu.
    pathname = `/projects/${encodeURIComponent(view.settingsTargetId ?? view.projectId!)}/settings`;
  } else if (view.settingsKind === "session" && view.projectId && (view.settingsTargetId ?? view.sessionId)) {
    pathname = `/projects/${encodeURIComponent(view.projectId)}/sessions/${encodeURIComponent(view.settingsTargetId ?? view.sessionId!)}/settings`;
  } else if (view.view === "usage") {
    pathname = "/usage";
  } else if (view.projectId && view.sessionId) {
    pathname = `/projects/${encodeURIComponent(view.projectId)}/sessions/${encodeURIComponent(view.sessionId)}`;
  } else if (view.projectId) {
    pathname = `/projects/${encodeURIComponent(view.projectId)}`;
  }
  const query: string[] = [];
  if (view.sessionFilter && view.sessionFilter !== "active") query.push(`filter=${view.sessionFilter}`);
  if (view.workspaceOpen !== undefined) query.push(`panel=${view.workspaceOpen ? "open" : "collapsed"}`);
  if (view.artifact) query.push(`artifact=${encodeQueryValue(view.artifact)}`);
  return { pathname, search: query.length ? `?${query.join("&")}` : "" };
}

/**
 * Whether moving from one view to another crosses a main-view boundary and
 * therefore deserves its own history entry (`pushState`). In-view refinements
 * that return false — the settings group, the Session list filter or the
 * panel state changed — are applied with `replaceState` so they do not
 * fragment the back stack.
 */
export function isPrimaryViewChange(previous: ViewState, next: ViewState): boolean {
  return previous.projectId !== next.projectId
    || previous.sessionId !== next.sessionId
    || previous.view !== next.view
    || previous.settingsKind !== next.settingsKind
    || previous.settingsTargetId !== next.settingsTargetId
    || previous.artifact !== next.artifact;
}
