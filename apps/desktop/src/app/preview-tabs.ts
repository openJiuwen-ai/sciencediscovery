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
  /** The artifact this tab is showing. One tab per artifact: its versions are
   *  a property of the open document, chosen with the picker beside it, not
   *  separate tabs. */
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
  /** Which version of the artifact is on screen. */
  versionId?: string;
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
  /** The Session the version was written in. The artifact list shows every
   *  Session's output, and a version is read through the Session that made it;
   *  absent means the open one. */
  sessionId?: string;
  source?: DocumentSource;
  versionId?: string;
}

export interface Placement extends TabState {
  /** True when the document was already open and its tab was focused instead
   *  of a second one being made (and read again). */
  reused: boolean;
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

/** Whether a tab is already showing the document this request names. A file is
 *  its path; an artifact is the artifact, whatever version the tab is on. */
function isOpen(slot: PreviewSlot, request: DocumentRequest): boolean {
  if (slot.home || slot.source !== request.source) return false;
  return request.artifactId !== undefined
    ? slot.artifactId === request.artifactId
    : slot.artifactId === undefined && slot.path === request.path;
}

/**
 * Puts a document in front of the user.
 *
 * A document that is already open is focused where it is: clicking the same row
 * twice is a request to look at it, not to open a second copy, and a second tab
 * for it would split the reader's scroll position in two. A failed read is the
 * exception — that tab is filled again, because the click may be the retry.
 *
 * Otherwise the home tab is replaced if it is still showing, and a new tab is
 * made after it. The content is read afterwards, so a slot that needs a read is
 * left in its loading state.
 */
export function placeDocument(
  tabs: PreviewSlot[],
  activeTabId: string,
  request: DocumentRequest,
): Placement {
  const open = tabs.find((tab) => isOpen(tab, request));
  if (open !== undefined && open.error === undefined) {
    return { activeTabId: open.id, reused: true, tabs };
  }
  if (open !== undefined) {
    // Fill the failed tab again rather than adding one beside it; its id keeps
    // the tab bar from flickering between two entries.
    const retried: PreviewSlot = { ...open, ...documentSlot(request, open.id) };
    return {
      activeTabId: retried.id,
      reused: false,
      tabs: tabs.map((tab) => (tab.id === retried.id ? retried : tab)),
    };
  }
  const index = tabs.findIndex((tab) => tab.id === activeTabId);
  const active = index === -1 ? undefined : tabs[index];
  if (active !== undefined && active.home) {
    // Replaced in place: the id survives, so the tab bar does not flicker
    // between two entries while the read is in flight.
    const replaced: PreviewSlot = documentSlot(request, active.id);
    const next = [...tabs];
    next[index] = replaced;
    return { activeTabId: replaced.id, reused: false, tabs: next };
  }
  const created: PreviewSlot = documentSlot(request, nextTabId(tabs));
  return { activeTabId: created.id, reused: false, tabs: [...tabs, created] };
}

/** The fields a document request decides, for a slot that is about to load. */
function documentSlot(request: DocumentRequest, id: string): PreviewSlot {
  return {
    artifactId: request.artifactId,
    content: undefined,
    error: undefined,
    home: false,
    id,
    label: request.label,
    loading: true,
    path: request.path,
    source: request.source,
    versionId: request.versionId,
  };
}

/**
 * Apply `patch` to one tab, but only while it still shows `versionId`.
 *
 * A version is read for one document and one version of it. Another pick can
 * move the tab before the answer lands; writing it then would leave the picker
 * naming one version while the page showed another. The check is what makes
 * the later request the winner, whichever read finishes last.
 */
export function patchVersion(
  tabs: TabState,
  id: string,
  versionId: string,
  patch: Partial<PreviewSlot>,
): TabState {
  return {
    ...tabs,
    tabs: tabs.tabs.map((tab) =>
      tab.id === id && tab.versionId === versionId ? { ...tab, ...patch } : tab),
  };
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
