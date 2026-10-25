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
 * The right panel's tab model, kept pure so the placement rule can be tested
 * without a DOM.
 *
 * The rule is the design's: the panel opens on a single tab titled 新标签页
 * whose content is the artifacts section and the workspace tree. The first
 * document opened replaces that tab's content in place — it is the only tab
 * that is ever overwritten. Anything opened while a document is already showing
 * gets a tab of its own, which is what makes following a link inside a preview
 * reachable rather than destructive.
 */

/** Which panel group opened a document. The artifact and file lists are two
 *  views of the same workspace, and a tab belongs to the one it came from:
 *  switching groups must not show an artifact under 文件 or a source file
 *  under 产物. */
export type DocumentSource = "artifact" | "file";

/** One slot in the panel's tab bar. */
export interface PreviewSlot {
  artifactId?: string;
  content?: string;
  error?: string;
  /** The initial tab — still holding the artifacts section and the tree. */
  home: boolean;
  id: string;
  label: string;
  loading: boolean;
  /** The workspace path, when the document has one. Artifacts may not. */
  path: string;
  source?: DocumentSource;
}

export interface TabState {
  activeTabId: string;
  tabs: PreviewSlot[];
}

/** A document the user asked to look at, before it has been read. */
export interface DocumentRequest {
  artifactId?: string;
  label: string;
  path: string;
  source?: DocumentSource;
}

export const HOME_TAB_ID = "home";

export function homeTab(): PreviewSlot {
  return { home: true, id: HOME_TAB_ID, label: "", loading: false, path: "" };
}

export function initialTabState(): TabState {
  const home = homeTab();
  return { activeTabId: home.id, tabs: [home] };
}

/** Document tabs are numbered, so the id of a new one is the highest existing
 *  number plus one. Deriving it from the list keeps `placeDocument` pure and
 *  keeps ids stable across a re-render. */
function nextTabId(tabs: PreviewSlot[]): string {
  let highest = 0;
  for (const tab of tabs) {
    const match = /^tab-(\d+)$/.exec(tab.id);
    if (match?.[1] !== undefined) highest = Math.max(highest, Number(match[1]));
  }
  return `tab-${highest + 1}`;
}

/**
 * Puts a document in front of the user: into the home tab if it is still
 * showing, otherwise into a new tab. The content itself is read afterwards, so
 * the returned slot is always in its loading state.
 */
export function placeDocument(
  tabs: PreviewSlot[],
  activeTabId: string,
  request: DocumentRequest,
): TabState {
  const index = tabs.findIndex((tab) => tab.id === activeTabId);
  const active = index === -1 ? undefined : tabs[index];
  if (active !== undefined && active.home) {
    // Replaced in place: the id survives, so the tab bar does not flicker
    // between two entries while the read is in flight.
    const replaced: PreviewSlot = {
      artifactId: request.artifactId,
      content: undefined,
      error: undefined,
      home: false,
      id: active.id,
      label: request.label,
      loading: true,
      path: request.path,
      source: request.source,
    };
    const next = [...tabs];
    next[index] = replaced;
    return { activeTabId: replaced.id, tabs: next };
  }
  const created: PreviewSlot = {
    artifactId: request.artifactId,
    home: false,
    id: nextTabId(tabs),
    label: request.label,
    loading: true,
    path: request.path,
    source: request.source,
  };
  return { activeTabId: created.id, tabs: [...tabs, created] };
}

/** Opens another empty tab, which is what the tab bar's `+` does. */
export function addTab(tabs: PreviewSlot[]): TabState {
  const created: PreviewSlot = { ...homeTab(), id: nextTabId(tabs) };
  return { activeTabId: created.id, tabs: [...tabs, created] };
}

export interface CloseResult extends TabState {
  /** Set when the close emptied the panel, which collapses it. */
  collapse: boolean;
}

/**
 * Closes a tab. Closing the last one leaves a fresh home tab behind and asks
 * for the panel to collapse: the design has no empty tab and no zero-tab panel,
 * so the next open starts clean.
 */
export function closeTab(tabs: PreviewSlot[], activeTabId: string, id: string): CloseResult {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return { activeTabId, collapse: false, tabs };
  const remaining = tabs.filter((tab) => tab.id !== id);
  if (remaining.length === 0) {
    const fresh = homeTab();
    return { activeTabId: fresh.id, collapse: true, tabs: [fresh] };
  }
  if (activeTabId !== id) return { activeTabId, collapse: false, tabs: remaining };
  // Focus falls back to the left neighbour, the convention the design uses.
  const next = remaining[Math.max(0, Math.min(index - 1, remaining.length - 1))];
  if (next === undefined) return { activeTabId, collapse: false, tabs: remaining };
  return { activeTabId: next.id, collapse: false, tabs: remaining };
}
