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

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { ApiRequestError, isAbortError } from "../api/client.js";
import type { ApiClient } from "../api/client.js";
import type { Session, WorkbenchSearchResult } from "../api/types.js";
import { searchWorkbench } from "../api/workbench.js";
import { commitsOnEnter, isImeComposing } from "../app/ime-enter.js";
import {
  fallbackInboxSnapshot,
  filterInboxSnapshot,
  loadInboxSearch,
  type InboxSearchSnapshot,
} from "../app/inbox-search.js";
import { dialogOrOverlayOpen, editableField, searchShortcutBlocked, shortcutKeyLabel } from "../app/search-shortcut.js";
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_GROUP_ORDER,
  artifactIdFromResult,
  flattenedSearchResults,
  groupSearchResults,
  mergeSearchResults,
  resultIsOpenable,
} from "../app/sidebar-search.js";
import { sessionTitle } from "../app/session-title.js";
import { TEXT } from "../text.js";

interface Props {
  client: ApiClient;
  /** The inbox Project, whose Sessions and artifacts the server's search
   *  skips; the panel reads them once per search session. */
  inboxProjectId?: string;
  onOpenArtifact: (artifactId: string, sessionId: string) => void;
  onOpenProject: (projectId: string) => void;
  onOpenSession: (sessionId: string, projectId: string) => void;
  onQueryChange: (query: string) => void;
  /** The controlled query, so the column can swap its lists for the results. */
  query: string;
  /** The inbox's loaded Sessions, used until (or if) the inbox read lands. */
  recent: readonly Session[];
}

type Status = "idle" | "loading" | "ready" | "error";

/** The part of a keydown the handler reads, from React or from `document`. */
interface SearchKeydown {
  defaultPrevented?: boolean;
  isComposing?: boolean;
  key: string;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
  preventDefault: () => void;
}

function resultLabel(result: WorkbenchSearchResult): string {
  return result.kind === "session" ? sessionTitle(result.label) : result.label;
}

/** The project (and Session, for an artifact) that places a result. A Project
 *  result is the context itself, so it has no second line. */
function resultDetail(result: WorkbenchSearchResult): string | undefined {
  if (result.kind === "project") return undefined;
  const project = result.projectName ?? TEXT.sidebar.recent;
  if (result.kind === "session") return project;
  const session = result.sessionTitle === undefined
    ? TEXT.search.deletedSession
    : sessionTitle(result.sessionTitle);
  return `${project} / ${session}`;
}

/** A localized reason for a failed search. */
export function searchFailureText(reason: unknown): string {
  if (reason instanceof TypeError) {
    // `fetch` rejects with a TypeError whose English text ("Failed to fetch")
    // is not the server's reason; inside the localized sentence it reads as a
    // leak rather than an explanation.
    return TEXT.search.fallbackReason;
  }
  if (reason instanceof ApiRequestError) {
    // `ApiClient`'s own fallback is an English transport line; inside a
    // Chinese sentence the localized phrase says more than "Request failed".
    if (/^Request failed \(\d+\)$/.test(reason.message)) return TEXT.search.fallbackReason;
    return reason.message;
  }
  if (reason instanceof Error && reason.message.trim() !== "") return reason.message;
  return TEXT.errors.generic;
}

function platformShortcutLabel(): string {
  if (typeof navigator === "undefined") return shortcutKeyLabel(undefined);
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return shortcutKeyLabel(data?.platform ?? navigator.platform);
}

/**
 * The column's search field and its grouped results (#1251).
 *
 * It consumes the workbench search the server already serves and adds the rows
 * that service deliberately leaves out — the inbox's Sessions (archived
 * included) and their artifacts, read once per search session by
 * `inbox-search.ts`. One settled query costs one search request: the field
 * debounces for `SEARCH_DEBOUNCE_MS` and aborts a request the next query
 * replaces.
 *
 * The input is a combobox with an aria-activedescendant listbox: the rows
 * themselves are never tab stops, the error and the truncation notice live
 * outside the listbox, and a polite live region announces loading, the result
 * count and the empty state.
 */
export function SidebarSearch({
  client,
  inboxProjectId,
  onOpenArtifact,
  onOpenProject,
  onOpenSession,
  onQueryChange,
  query,
  recent,
}: Props) {
  const [results, setResults] = useState<WorkbenchSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState(-1);
  const [inbox, setInbox] = useState<InboxSearchSnapshot>();
  const [inboxFailed, setInboxFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const optionRefs = useRef(new Map<number, HTMLDivElement>());
  const baseId = useId();
  const listId = `${baseId}-search-results`;
  const active = query.trim() !== "";
  const hasQuery = query !== "";
  const shortcutLabel = useMemo(platformShortcutLabel, []);

  // Ctrl/Cmd+K focuses the field from anywhere on the page, unless a modal
  // owns the keyboard or a rename field is mid-edit (its blur would commit).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLocaleLowerCase() !== "k") return;
      if (typeof document !== "undefined"
        && searchShortcutBlocked(document.activeElement, dialogOrOverlayOpen(document))) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => () => requestRef.current?.abort(), []);

  // The inbox is not in `/api/search` at all. Read it once when the search
  // opens; every further keystroke filters the snapshot locally.
  useEffect(() => {
    if (!active || inboxProjectId === undefined) {
      setInbox(undefined);
      setInboxFailed(false);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    setInbox(undefined);
    setInboxFailed(false);
    void loadInboxSearch(client, inboxProjectId, controller.signal).then(
      (snapshot) => {
        if (!alive) return;
        setInbox(snapshot);
        setInboxFailed(snapshot.failed);
      },
      () => {
        if (!alive) return;
        setInbox(undefined);
        setInboxFailed(true);
      },
    );
    return () => {
      alive = false;
      controller.abort();
    };
  }, [active, client, inboxProjectId]);

  useEffect(() => {
    // A new query replaces the old one: its request and its rows both belong
    // to a search the reader has already typed past.
    requestRef.current?.abort();
    const needle = query.trim();
    setResults([]);
    setTotal(0);
    setHasMore(false);
    setError("");
    if (needle === "") {
      setStatus("idle");
      return;
    }
    setStatus("loading");
    const timer = setTimeout(() => {
      const controller = new AbortController();
      requestRef.current = controller;
      void searchWorkbench(client, needle, { signal: controller.signal }).then(
        (response) => {
          if (controller.signal.aborted) return;
          setResults(response.results);
          setTotal(response.total);
          setHasMore(response.hasMore);
          setStatus("ready");
        },
        (reason: unknown) => {
          if (controller.signal.aborted || isAbortError(reason)) return;
          setError(searchFailureText(reason));
          setStatus("error");
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [attempt, client, query]);

  // While a read is in flight the loaded inbox rows stand in; once the
  // snapshot lands it replaces them, archived Sessions and artifacts included.
  const fallbackInbox = useMemo(() => fallbackInboxSnapshot(recent), [recent]);
  const merged = useMemo(() => {
    if (status !== "ready") return [];
    const known = new Set(results.map((result) => result.id));
    const extras = filterInboxSnapshot(inbox ?? fallbackInbox, query, known);
    return mergeSearchResults(results, extras);
  }, [fallbackInbox, inbox, query, results, status]);
  const groups = useMemo(() => groupSearchResults(merged), [merged]);
  // The panel's own order is the arrow keys' order.
  const flat = useMemo(() => flattenedSearchResults(merged), [merged]);
  const positions = useMemo(() => new Map(flat.map((result, index) => [result.id, index])), [flat]);
  const localExtras = merged.length - results.length;
  const displayTotal = total + Math.max(0, localExtras);

  useEffect(() => {
    setSelected(flat.length > 0 ? 0 : -1);
  }, [flat]);

  // The selected row must be the one the reader can see: past the panel's
  // height, Enter would otherwise open an off-screen result.
  useEffect(() => {
    if (selected < 0) return;
    optionRefs.current.get(selected)?.scrollIntoView?.({ block: "nearest" });
  }, [flat, selected]);

  const open = useCallback((result: WorkbenchSearchResult) => {
    if (!resultIsOpenable(result)) return;
    if (result.kind === "session" && result.sessionId !== undefined) {
      onOpenSession(result.sessionId, result.projectId);
    } else if (result.kind === "project") {
      onOpenProject(result.projectId);
    } else if (result.kind === "artifact") {
      const artifactId = artifactIdFromResult(result);
      if (artifactId !== undefined && result.sessionId !== undefined) {
        onOpenArtifact(artifactId, result.sessionId);
      }
    }
    // Opening a result ends the search: the column goes back to the list the
    // reader will find the opened conversation in.
    onQueryChange("");
  }, [onOpenArtifact, onOpenProject, onOpenSession, onQueryChange]);

  const handleKey = useCallback((event: SearchKeydown) => {
    // A dialogue is the topmost surface, and a key another handler already
    // claimed is not ours. Both are checked before the panel acts.
    if (event.defaultPrevented === true) return;
    if (typeof document !== "undefined" && dialogOrOverlayOpen(document)) return;
    // Every key here belongs to an open IME composition: the candidate window
    // owns the arrows, and Escape cancels the composition, not the search.
    if (isImeComposing(event)) return;
    if (event.key === "Escape") {
      if (!hasQuery) return;
      event.preventDefault();
      onQueryChange("");
      // The field is the sensible place to continue from; blurring left the
      // reader on <body>, restarting Tab at the top of the document.
      inputRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (flat.length === 0) return;
      event.preventDefault();
      setSelected((current) => {
        const step = event.key === "ArrowDown" ? 1 : -1;
        const start = current < 0 ? (step > 0 ? -1 : 0) : current;
        return (start + step + flat.length) % flat.length;
      });
      return;
    }
    if (commitsOnEnter(event) && flat.length > 0) {
      event.preventDefault();
      const result = flat[selected >= 0 ? selected : 0];
      if (result !== undefined) open(result);
    }
  }, [flat, hasQuery, onQueryChange, open, selected]);

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => handleKey(event);

  // Arrow/Escape keep working after focus leaves the input (Tab, a click on
  // the column, a result row): the panel is the active surface, not the field.
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // A dialogue or overlay owns its own keys. An editable field owns its
      // own arrows and Escape (caret movement, cancel) — the composer is the
      // one that used to lose its caret to the panel.
      if (dialogOrOverlayOpen(document)) return;
      if (event.target === inputRef.current) return;
      if (editableField(event.target)) return;
      // Enter activates a focused button or link; the panel only keeps
      // arrows/Escape for those, which is the "focus left the field" path.
      if (event.key === "Enter" && event.target instanceof Element
        && event.target.closest("button, a[href]") !== null) {
        return;
      }
      handleKey(event);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, handleKey]);

  // A click anywhere outside the search closes the stale result view.
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (typeof Node !== "undefined" && target instanceof Node && containerRef.current?.contains(target) === true) {
        return;
      }
      onQueryChange("");
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [active, onQueryChange]);

  const statusText = status === "loading"
    ? TEXT.search.loading
    : status === "ready"
      ? flat.length === 0 ? TEXT.search.noResults : TEXT.search.count(flat.length)
      : "";

  return (
    <div className={`side-search${active ? " is-active" : ""}`} ref={containerRef}>
      <div className="side-search-field">
        <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="14">
          <circle cx="11" cy="11" r="7" />
          <path d="m16.5 16.5 4 4" />
        </svg>
        <input
          aria-activedescendant={selected >= 0 && flat[selected] !== undefined ? `${baseId}-result-${selected}` : undefined}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={flat.length > 0}
          aria-haspopup="listbox"
          aria-label={TEXT.search.label}
          className="side-search-input"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={TEXT.search.placeholder}
          ref={inputRef}
          role="combobox"
          type="search"
          value={query}
        />
        {hasQuery ? (
          <button
            aria-label={TEXT.search.clear}
            className="side-search-clear"
            onClick={() => {
              onQueryChange("");
              inputRef.current?.focus();
            }}
            title={TEXT.search.clear}
            type="button"
          >
            ×
          </button>
        ) : (
          <kbd aria-hidden="true" className="side-search-kbd">{shortcutLabel}</kbd>
        )}
      </div>

      {status === "error" ? (
        <div className="side-search-error" role="alert">
          <p>{TEXT.search.failed(error)}</p>
          <button
            className="side-search-retry"
            onClick={() => setAttempt((current) => current + 1)}
            type="button"
          >
            {TEXT.search.retry}
          </button>
        </div>
      ) : (
        <div aria-live="polite" className="side-search-status">
          <span>{statusText}</span>
          {status === "ready" && hasMore ? (
            <span className="side-search-more">{TEXT.search.more(merged.length, displayTotal)}</span>
          ) : null}
        </div>
      )}

      {inboxFailed && active ? <p className="side-search-note" role="status">{TEXT.search.inboxIncomplete}</p> : null}

      {status === "ready" && flat.length === 0 ? (
        <div className="side-search-empty">
          {/* The status line announces "no results"; the block states the
              full sentence as a title, above its explanation. */}
          <p className="side-search-empty-title">{TEXT.search.emptyTitle}</p>
          <p className="side-search-note">{TEXT.search.emptyBody}</p>
        </div>
      ) : null}

      {flat.length > 0 ? (
        <div aria-label={TEXT.search.label} className="side-search-results" id={listId} role="listbox">
          {SEARCH_GROUP_ORDER.map((kind) => {
            const rows = groups[kind];
            if (rows.length === 0) return null;
            return (
              <div aria-labelledby={`${baseId}-group-${kind}`} className="side-search-group" key={kind} role="group">
                <div className="side-search-group-label" id={`${baseId}-group-${kind}`}>
                  <span>{TEXT.search.groups[kind]}</span>
                  <span className="side-search-count">{rows.length}</span>
                </div>
                {rows.map((result) => {
                  const index = positions.get(result.id) ?? -1;
                  const openable = resultIsOpenable(result);
                  const detail = resultDetail(result);
                  const label = resultLabel(result);
                  return (
                    <div
                      aria-disabled={openable ? undefined : true}
                      aria-selected={index === selected}
                      className={`side-search-result${index === selected ? " is-selected" : ""}${openable ? "" : " is-unavailable"}`}
                      id={index >= 0 ? `${baseId}-result-${index}` : undefined}
                      key={result.id}
                      onClick={() => open(result)}
                      onMouseEnter={() => {
                        if (openable) setSelected(index);
                      }}
                      ref={(node) => {
                        if (node === null) optionRefs.current.delete(index);
                        else optionRefs.current.set(index, node);
                      }}
                      role="option"
                      title={detail === undefined ? label : `${label} · ${detail}`}
                    >
                      <span className="side-search-result-copy">
                        <span className="side-search-result-label">{label}</span>
                        {detail === undefined ? null : (
                          <span className="side-search-result-detail">
                            {detail}
                            {result.archived === true && result.kind === "session"
                              ? <em className="side-search-archived">{TEXT.sidebar.archived}</em>
                              : null}
                            {openable ? null : <em className="side-search-archived">{TEXT.search.artifactUnavailable}</em>}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
