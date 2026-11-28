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

import type { WorkbenchSearchResponse, WorkbenchSearchResult } from "../api/types.js";
import { groupsFor, searchDetail } from "../app/session-search.js";
import { TEXT } from "../text.js";
import { SearchHitIcon } from "./search-hit-icons.js";
import { useTopmostEscape } from "./use-dialog-escape.js";

/** 全部 groups every hit by kind; a kind shows only that kind. */
export type SearchKindFilter = "all" | "project" | "session" | "artifact";

const KINDS: readonly SearchKindFilter[] = ["all", "project", "session", "artifact"];

interface Props {
  /** The query the results belong to; the dialog is controlled by the workspace. */
  query: string;
  results?: WorkbenchSearchResponse;
  error?: string;
  kind: SearchKindFilter;
  onClose: () => void;
  onKind: (kind: SearchKindFilter) => void;
  onPick: (result: WorkbenchSearchResult) => void;
  onQuery: (query: string) => void;
  onRetry: () => void;
}

/**
 * 搜索, as a dialog over the page.
 *
 * The column's title row carries the magnifier and nothing else: a search is a
 * moment, not a row that the list has to live under. Opening it puts the caret
 * in the field, and the footer says what is being looked through — 全部 groups
 * the hits by kind, newest first inside each kind, and 项目 / 会话 / 产物 show
 * only theirs.
 */
export function SearchDialog({
  query,
  results,
  error,
  kind,
  onClose,
  onKind,
  onPick,
  onQuery,
  onRetry,
}: Props) {
  const field = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    field.current?.focus();
  }, []);

  // The footer's kinds are buttons: a reader who picked one has the focus there,
  // not in the field, and Escape has to close the dialog wherever the focus sits.
  // Tab is not trapped — the page behind stays reachable, which is the one limit
  // this dialog keeps.
  useTopmostEscape(onClose);

  const groups = groupsFor(results?.results ?? [], kind);
  const hits = groups.flatMap((group) => group.results);

  return (
    <div
      className="search-overlay"
      onMouseDown={(event) => {
        // A click outside the panel closes it; a click inside does not. The
        // default is prevented because mousedown would move the focus to this
        // overlay — which cannot hold it — and take it away again from the
        // magnifier that closing hands it back to.
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
    >
      <div aria-label={TEXT.sidebar.searchLabel} aria-modal="true" className="search-panel" role="dialog">
        <div className="search-panel-head">
          <svg aria-hidden="true" className="search-panel-glyph" fill="none" height="16" stroke="currentColor"
            strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 24 24" width="16">
            <circle cx="11" cy="11" r="7" />
            <path d="m16.5 16.5 4 4" />
          </svg>
          <input
            aria-label={TEXT.sidebar.searchLabel}
            className="search-panel-input"
            ref={field}
            onChange={(event) => {
              setActive(-1);
              onQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const delta = event.key === "ArrowDown" ? 1 : -1;
                const count = hits.length;
                if (count === 0) return;
                event.preventDefault();
                setActive((current) => (current + delta + count) % count);
                return;
              }
              if (event.key === "Enter") {
                const hit = hits[active];
                if (hit !== undefined) {
                  event.preventDefault();
                  onPick(hit);
                }
              }
            }}
            placeholder={TEXT.sidebar.searchPlaceholder}
            type="text"
            value={query}
          />
          <button
            aria-label={TEXT.sidebar.searchClose}
            className="search-panel-close"
            onClick={onClose}
            title={TEXT.sidebar.searchClose}
            type="button"
          >
            ×
          </button>
        </div>

        <div className="search-panel-body">
          {error !== undefined ? (
            <p className="search-panel-note is-error" role="alert">
              {error}
              <button className="search-panel-retry" onClick={onRetry} type="button">
                {TEXT.sidebar.searchRetry}
              </button>
            </p>
          ) : query.trim() === "" ? (
            <p className="search-panel-note">{TEXT.sidebar.searchHint}</p>
          ) : results === undefined ? null : hits.length === 0 ? (
            <p className="search-panel-note">{TEXT.sidebar.searchEmpty(query.trim())}</p>
          ) : (
            groups.map((group) => (
              <div className="search-panel-group" key={group.kind}>
                {kind === "all" ? (
                  <span className="search-panel-heading">
                    {group.kind === "project" ? TEXT.sidebar.searchProjects
                      : group.kind === "session" ? TEXT.sidebar.searchSessions : TEXT.sidebar.searchArtifacts}
                  </span>
                ) : null}
                {group.results.map((result) => (
                  <button
                    className={`search-hit${hits[active] === result ? " is-active" : ""}`}
                    key={`${result.kind}:${result.id}`}
                    onClick={() => onPick(result)}
                    type="button"
                  >
                    <SearchHitIcon kind={result.kind} path={result.path} />
                    <span className="search-hit-text">
                      <span className="search-hit-label">{result.label}</span>
                      {searchDetail(result) === result.label ? null : (
                        <span className="search-hit-detail">{searchDetail(result)}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="search-panel-foot" role="group" aria-label={TEXT.sidebar.searchKinds}>
          {KINDS.map((option) => (
            <button
              aria-pressed={kind === option}
              className={`search-kind${kind === option ? " is-on" : ""}`}
              key={option}
              onClick={() => onKind(option)}
              type="button"
            >
              {option === "all" ? TEXT.sidebar.searchAll
                : option === "project" ? TEXT.sidebar.searchProjects
                  : option === "session" ? TEXT.sidebar.searchSessions : TEXT.sidebar.searchArtifacts}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
