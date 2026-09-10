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

import type { ComposerReference, SkillDescriptor, WorkbenchSearchResult } from "@sciencediscovery/schema";

import { CloseIcon, FileIcon, ProjectIcon, SearchIcon, SessionIcon, SparkleIcon } from "../icons.js";
import { useLocale } from "../i18n/index.js";

export interface ComposerTrigger {
  query: string;
  start: number;
  symbol: "#" | "/" | "@";
}

export type ComposerCommandSuggestion = {
  command: `/${string}`;
  detail: string;
  label: string;
  reference?: never;
};

export type ComposerSuggestion = ComposerCommandSuggestion | {
  command?: never;
  detail: string;
  label?: never;
  reference: ComposerReference;
};

export const SKILL_AUTHORING_COMMANDS: ComposerCommandSuggestion[] = [
  {
    command: "/skill-creator",
    detail: "Describe a workflow and let the Agent create a reviewable Skill package",
    label: "skill-creator",
  },
  {
    command: "/distill-session",
    detail: "Distill this Session into a reviewable Skill using its conversation and run history",
    label: "distill-session",
  },
];

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

export const GLOBAL_SEARCH_DEBOUNCE_MS = 250;

export function insertComposerCommand(
  text: string,
  trigger: ComposerTrigger,
  command: `/${string}`,
  cursor = text.length,
): string {
  return `${text.slice(0, trigger.start)}${command} ${text.slice(cursor)}`;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function selectedSkillAuthoringCommands(text: string): ComposerCommandSuggestion[] {
  return SKILL_AUTHORING_COMMANDS.filter(({ command }) =>
    new RegExp(`(?:^|\\s)${escapeRegularExpression(command)}(?=\\s|$)`).test(text));
}

export function removeSkillAuthoringCommand(text: string, command: `/${string}`): string {
  return text
    .replace(new RegExp(`(^|\\s)${escapeRegularExpression(command)}(?=\\s|$)`, "g"), "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+/, "");
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
    `${suggestion.reference?.label ?? suggestion.label}\n${suggestion.detail}`.toLocaleLowerCase().includes(needle)).slice(0, 8);
  if (!visible.length) return null;

  return (
    <div className="composer-reference-menu" role="listbox" aria-label={`${trigger.symbol} context suggestions`}>
      <div className="composer-reference-heading">
        <strong>{trigger.symbol === "@" ? t("search.artifacts") : trigger.symbol === "#" ? t("sidebar.sessions") : t("search.skills")}</strong>
        <span>{t("search.structuredContext")}</span>
      </div>
      {visible.map((suggestion) => {
        const label = suggestion.command ?? suggestion.reference.label;
        return (
          <button className={suggestion.command ? "composer-command-suggestion" : undefined} key={suggestion.command ?? `${suggestion.reference.kind}:${suggestion.reference.id}`} title={`${label} · ${suggestion.detail}`} type="button" role="option" onClick={() => onSelect(suggestion)}>
            {suggestion.command ? <i aria-hidden="true"><SparkleIcon size={16} /></i> : null}
            <span className="composer-suggestion-copy"><strong>{label}</strong><small>{suggestion.detail}</small></span>
            {suggestion.command ? <em>{t("composer.authoring")}</em> : null}
          </button>
        );
      })}
    </div>
  );
}

export function ComposerCommandChips({
  commands,
  onRemove,
}: {
  commands: ComposerCommandSuggestion[];
  onRemove: (command: ComposerCommandSuggestion) => void;
}) {
  const { t } = useLocale();
  if (!commands.length) return null;
  return (
    <div className="composer-command-chips" aria-label={t("composer.selectedAuthoringCommands")}>
      {commands.map((command) => (
        <button aria-label={t("composer.removeCommand", { command: command.command })} key={command.command} title={`${command.command} · ${command.detail}`} type="button" onClick={() => onRemove(command)}>
          <i aria-hidden="true"><SparkleIcon size={13} /></i>
          <span><strong>{command.command}</strong><small>{t("composer.skillAuthoring")}</small></span>
          <CloseIcon aria-hidden="true" size={12} />
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
  hasMore,
  loading,
  onClose,
  onQueryChange,
  onSelect,
  query,
  results,
  total,
}: {
  hasMore: boolean;
  loading: boolean;
  onClose: () => void;
  onQueryChange: (query: string) => void;
  onSelect: (result: WorkbenchSearchResult) => void;
  query: string;
  results: WorkbenchSearchResult[];
  total: number;
}) {
  const { t } = useLocale();
  const visible = results.slice(0, 80);
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
          {loading ? <p>{t("search.loading")}</p> : null}
          {!loading && !visible.length ? <p>{t("search.empty")}</p> : null}
          {!loading && (hasMore || total > visible.length) ? (
            <p>{t("search.more", { count: visible.length, total })}</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
