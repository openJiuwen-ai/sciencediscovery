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

import type { ComposerReference, SkillDescriptor, WorkbenchSearchResult } from "@science-agent/schema";

import { CloseIcon, FileIcon, ProjectIcon, SearchIcon, SessionIcon } from "../icons.js";
import { useLocale } from "../i18n/index.js";

export interface ComposerTrigger {
  query: string;
  start: number;
  symbol: "#" | "/" | "@";
}

export interface ComposerSuggestion {
  detail: string;
  reference: ComposerReference;
}

/**
 * `/` offers exactly the skills the Session can run. `effectiveSkillIds` is the
 * Session's resolved skill set — the whole catalog in `all` mode, the
 * Project/Session whitelist in `selected` mode. Without a Session there is
 * nothing to resolve against, so the full catalog is offered.
 */
export function composerSkillSuggestions(
  skills: SkillDescriptor[],
  effectiveSkillIds: readonly string[] | undefined,
): ComposerSuggestion[] {
  const allowed = effectiveSkillIds && new Set(effectiveSkillIds);
  return skills
    .filter((skill) => !allowed || allowed.has(skill.id))
    .map((skill) => ({
      detail: skill.description,
      reference: { id: skill.id, kind: "skill", label: skill.name } satisfies ComposerReference,
    }));
}

export function getComposerTrigger(text: string, cursor = text.length): ComposerTrigger | undefined {
  const beforeCursor = text.slice(0, cursor);
  const match = beforeCursor.match(/(?:^|\s)([@#/])([^\s@#/]{0,80})$/);
  if (!match || (match[1] !== "@" && match[1] !== "#" && match[1] !== "/")) return undefined;
  return {
    query: match[2] ?? "",
    start: cursor - (match[2]?.length ?? 0) - 1,
    symbol: match[1],
  };
}

export function composerReferenceToken(reference: ComposerReference): string {
  if (reference.kind === "artifact") return `@[${reference.label}]`;
  if (reference.kind === "session") return `#[${reference.label}]`;
  return `/${reference.id}`;
}

export function insertComposerReference(
  text: string,
  trigger: ComposerTrigger,
  reference: ComposerReference,
  cursor = text.length,
): string {
  return `${text.slice(0, trigger.start)}${composerReferenceToken(reference)} ${text.slice(cursor)}`;
}

export function filterSearchResults(results: WorkbenchSearchResult[], query: string): WorkbenchSearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return results.slice(0, 80);
  return results.filter((result) =>
    `${result.label}\n${result.detail}\n${result.kind}`.toLocaleLowerCase().includes(needle)).slice(0, 80);
}

export function ComposerReferenceMenu({
  onSelect,
  suggestions,
  trigger,
}: {
  onSelect: (suggestion: ComposerSuggestion) => void;
  suggestions: ComposerSuggestion[];
  trigger: ComposerTrigger;
}) {
  const { t } = useLocale();
  const needle = trigger.query.toLocaleLowerCase();
  const visible = suggestions.filter((suggestion) =>
    `${suggestion.reference.label}\n${suggestion.detail}`.toLocaleLowerCase().includes(needle)).slice(0, 8);
  if (!visible.length) return null;

  return (
    <div className="composer-reference-menu" role="listbox" aria-label={`${trigger.symbol} context suggestions`}>
      <div className="composer-reference-heading">
        <strong>{trigger.symbol === "@" ? t("search.artifacts") : trigger.symbol === "#" ? t("sidebar.sessions") : t("search.skills")}</strong>
        <span>{t("search.structuredContext")}</span>
      </div>
      {visible.map((suggestion) => (
        <button key={`${suggestion.reference.kind}:${suggestion.reference.id}`} title={`${suggestion.reference.label} · ${suggestion.detail}`} type="button" role="option" onClick={() => onSelect(suggestion)}>
          <span>{suggestion.reference.label}</span><small>{suggestion.detail}</small>
        </button>
      ))}
    </div>
  );
}

export function ComposerReferenceChips({
  onRemove,
  references,
}: {
  onRemove: (reference: ComposerReference) => void;
  references: ComposerReference[];
}) {
  const { t } = useLocale();
  if (!references.length) return null;
  return (
    <div className="composer-reference-chips" aria-label={t("search.attachedContext")}>
      {references.map((reference) => (
        <button aria-label={`Remove ${reference.label} from attached context`} key={`${reference.kind}:${reference.id}`} title={`Remove ${reference.label}`} type="button" onClick={() => onRemove(reference)}>
          <span>{reference.kind === "artifact" ? "@" : reference.kind === "session" ? "#" : "/"}</span>
          {reference.label}<i aria-hidden="true"><CloseIcon size={12} /></i>
        </button>
      ))}
    </div>
  );
}

export function GlobalSearchDialog({
  onClose,
  onQueryChange,
  onSelect,
  query,
  results,
}: {
  onClose: () => void;
  onQueryChange: (query: string) => void;
  onSelect: (result: WorkbenchSearchResult) => void;
  query: string;
  results: WorkbenchSearchResult[];
}) {
  const { t } = useLocale();
  const visible = filterSearchResults(results, query);
  return (
    <div className="config-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="global-search-dialog" role="dialog" aria-modal="true" aria-label={t("search.placeholder")}>
        <div className="global-search-input">
          <span aria-hidden="true"><SearchIcon size={20} /></span>
          <input autoFocus value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={t("search.placeholder")} />
          <button type="button" onClick={onClose} aria-label={t("search.close")} title={t("search.close")}>Esc</button>
        </div>
        <div className="global-search-results">
          {visible.map((result) => (
            <button key={result.id} type="button" onClick={() => onSelect(result)} title={`${result.label} · ${result.detail}`}>
              <i>{result.kind === "project" ? <ProjectIcon size={16} /> : result.kind === "session" ? <SessionIcon size={16} /> : <FileIcon size={16} />}</i>
              <span><strong>{result.label}</strong><small>{result.detail}</small></span>
              <em>{result.kind}</em>
            </button>
          ))}
          {!visible.length ? <p>{t("search.empty")}</p> : null}
        </div>
      </section>
    </div>
  );
}
