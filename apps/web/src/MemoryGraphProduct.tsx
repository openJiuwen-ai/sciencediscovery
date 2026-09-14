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

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { EnvironmentRevision, MemoryGraphEdgeType, MemoryGraphNode, MemorySubgraph } from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { translateActive } from "./i18n/index.js";
import { useLocale } from "./i18n/LocaleProvider.js";
import { graphNodeName } from "./MemoryGraphCanvas.js";
import { MarkdownRenderer } from "./Markdown.js";
import { Field, humanizeKey, LinkField, LongText, partitionEvidenceExtra, TimeField } from "./NodeField.js";

/** Edge-type display order in the relations block: produces is the primary
 *  "this node made that" claim and reads first; next is the temporal chain
 *  (a sibling produced later) and reads beneath it. Others follow the schema
 *  order; any unknown type lands last. */
const EDGE_DISPLAY_ORDER: MemoryGraphEdgeType[] = ["produces", "next", "extracts", "supports", "stated_in", "supersedes", "input", "feeds"];

export type ResolveState = "idle" | "loading" | "missing" | "resolved";

/**
 * Map a graph Artifact (or SourceFile — uploaded file's catalog row, see
 * block 1's upload pipeline) onto a real session artifact's logical name, so
 * the shared artifacts panel can load it. The graph node carries both the
 * suffix-less workspace path and a precise artifact_id; we match on id first,
 * falling back to path/logicalName for legacy nodes that lack an id.
 *
 * For SourceFile the catalog entry has ``origin="user_upload"`` and no version;
 * matching is on ``extra.path`` (== ``extra.name`` == logicalName for uploads)
 * and constrained to the same session so a same-named upload in another
 * session never wins.
 */
export function useResolvedArtifactName(
  client: ApiClient,
  sessionId: string,
  node?: MemoryGraphNode,
): { name?: string; state: ResolveState } {
  const [name, setName] = useState<string>();
  const [state, setState] = useState<ResolveState>("idle");
  // The graph subgraph is re-fetched on a timer, so `node` is a fresh object on
  // every poll even when nothing changed. Key the lookup on the identity that
  // actually decides the answer, not on the object reference — otherwise the
  // resolved name is dropped and the whole product column remounts every poll.
  const isArtifact = node?.label === "Artifact";
  const isSourceFile = node?.label === "SourceFile";
  const extra = node?.extra ?? {};
  const lookupKey = isArtifact
    ? JSON.stringify([node.id, extra.path ?? null, extra.artifact_id ?? null])
    : isSourceFile
      ? JSON.stringify([extra.path ?? null, extra.name ?? null])
      : "";

  useEffect(() => {
    if (!lookupKey) { setName(undefined); setState("idle"); return; }
    let active = true;
    setState((current) => current === "resolved" ? current : "loading");
    const wanted = (JSON.parse(lookupKey) as Array<string | null>)
      .filter((value): value is string => typeof value === "string" && !!value.trim());
    void client.listArtifacts(sessionId)
      .then((artifacts) => {
        if (!active) return;
        // Prefer an exact id match — wanted already contains extra.artifact_id.
        // logicalName is a fallback only: cross-session dedup rewrites the 2nd
        // same-named artifact to "name (s-<prefix>"), while extra.path carries
        // the suffix-less base name, so a name match can resolve to another
        // session's artifact (P2). For SourceFile there's no artifact_id —
        // match is name/path only, pinned to the same session.
        const inSession = isSourceFile
          ? artifacts.filter((candidate) => candidate.sessionId === sessionId)
          : artifacts;
        const match = inSession.find((candidate) => wanted.includes(candidate.id))
          ?? inSession.find((candidate) => wanted.some((value) =>
            candidate.logicalName === value || candidate.logicalName.endsWith(`/${value}`)));
        // Only publish a change; re-resolving the same node must not churn the
        // name, or the embedded artifact panel unmounts and refetches.
        if (match) { setName(match.logicalName); setState("resolved"); }
        else { setName(undefined); setState("missing"); }
      })
      .catch(() => { if (active) { setName(undefined); setState("missing"); } });
    return () => { active = false; };
  }, [client, isSourceFile, lookupKey, sessionId]);

  return { name, state };
}

/** Per-label detail view. Dispatches to a semantic component for each node
 *  type; falls back to the raw key/value dump for unknown labels. Each typed
 *  component composes the shared Field/LongText/TimeField/LinkField primitives
 *  so hashes decode, long text truncates, times format, links open. */
function NodeProperties({ node, client, onOpenEvolveRun, sessionId, subgraph, scopeChildCounts }: {
  node: MemoryGraphNode;
  client: ApiClient;
  onOpenEvolveRun?: (runId: string) => void;
  sessionId: string;
  subgraph: MemorySubgraph;
  scopeChildCounts?: ReadonlyMap<string, number>;
}) {
  const extra = (node.extra ?? {}) as Record<string, unknown>;
  switch (node.label) {
    case "ResearchGoal": return <ResearchGoalDetail extra={extra} />;
    case "Task": return <TaskDetail extra={extra} scopeChildCount={scopeChildCounts?.get(node.id)} />;
    // A ToolCall can be an evolve search (tool_type program_evolution): it
    // gets the node/subgraph so the detail can follow the `searches` edge.
    case "ToolCall": return <TaskDetail extra={extra} node={node} onOpenEvolveRun={onOpenEvolveRun} scopeChildCount={scopeChildCounts?.get(node.id)} subgraph={subgraph} />;
    case "SearchRun": return <div className="node-detail-body">
      {typeof extra.status === "string" ? <span className={`node-status-badge node-status-${extra.status}`}>{extra.status}</span> : null}
      <EvolveRunSummary
        extra={extra}
        onOpenEvolveRun={onOpenEvolveRun}
        runId={typeof extra.search_id === "string" ? extra.search_id : undefined}
      />
    </div>;
    case "Paper": return <PaperDetail extra={extra} />;
    case "Evidence": return <EvidenceDetail extra={extra} />;
    case "Claim": return <ClaimDetail extra={extra} />;
    case "Code": return <CodeDetail node={node} client={client} sessionId={sessionId} subgraph={subgraph} />;
    case "SourceFile": return <SourceFileDetail extra={extra} />;
    case "WebPage": return <WebPageDetail extra={extra} client={client} sessionId={sessionId} webPageId={node.id} />;
    case "DbRecord": return <DbRecordDetail extra={extra} />;
    default: return <RawNodeProperties extra={extra} />;
  }
}

// --- ResearchGoal -----------------------------------------------------------

function ResearchGoalDetail({ extra }: { extra: Record<string, unknown> }) {
  const { t } = useLocale();
  const objective = extra.core_objective;
  const topicScope = Array.isArray(extra.topic_scope) ? (extra.topic_scope as unknown[]).filter((v) => v !== null && v !== undefined && v !== "") : undefined;
  return <div className="node-detail-body">
    {objective ? <section className="node-detail-section">
      <h4 className="node-detail-section-label">{t("node.field.core_objective")}</h4>
      <LongText value={objective} maxLines={3} />
    </section> : null}
    <dl className="node-detail-fields">
      {extra.domain ? <Field label={t("node.field.domain")} value={extra.domain} /> : null}
      {topicScope?.length ? <Field label={t("node.field.topic_scope")}><span>{topicScope.join(", ")}</span></Field> : null}
      {extra.created_at ? <Field label={t("node.field.created_at")}><TimeField value={extra.created_at} /></Field> : null}
    </dl>
  </div>;
}

// --- Task / ToolCall --------------------------------------------------------

/** The classification chips the UI can label. The graph's vocabulary is
 *  ``execution | search`` plus the two pseudo-types below; ``program_evolution``
 *  and ``subagent`` are markers rather than tool classes (an evolve search run
 *  and a subagent scope), which is why they survive the collapse untouched. */
export type ClassificationLabelKey =
  | "node.task_type.execution"
  | "node.task_type.search"
  | "node.task_type.subagent"
  | "node.task_type.program_evolution";

/** Values written before the vocabulary was collapsed onto execution/search.
 *
 *  This is a permanent part of the read path, not a transitional shim:
 *  ``tool_type`` is written only in the ``MERGE ... ON CREATE SET`` (see
 *  persistence.py), so a historical node keeps whatever value it was born
 *  with and no migration will ever rewrite it — the repo's precedent is
 *  read-side tolerance rather than a backfill cypher (0bb12ee9). Only the
 *  display side needs this: nothing branches on the value except the evolve
 *  marker check below, which is why the collapse is safe here.
 */
export const LEGACY_CLASSIFICATION_ALIASES: Record<string, string> = {
  code_execution: "execution",
  literature_search: "search",
  web_search: "search",
  db_search: "search",
  search_preprints: "search",
  lookup_doi: "search",
};

/** Friendly display for known classification values; unknown values pass
 *  through unchanged (a chip with a raw value beats an empty chip). Legacy
 *  values fold onto the two buckets first — the label follows the collapsed
 *  value, but the fallthrough still returns the *original* string, so an
 *  unknown value never displays as its alias. */
export function taskTypeLabel(
  classification: string,
  t: (key: ClassificationLabelKey) => string,
): string {
  const value = LEGACY_CLASSIFICATION_ALIASES[classification] ?? classification;
  if (value === "execution") return t("node.task_type.execution");
  if (value === "search") return t("node.task_type.search");
  if (value === "subagent") return t("node.task_type.subagent");
  if (value === "program_evolution") return t("node.task_type.program_evolution");
  return classification;
}

/**
 * A Markdown-rendered section for a subagent scope's `objective`/`summary`. The
 * scope's summary is the subagent's final assistant message (see
 * runs/index.ts: `assistantOutput` = last assistant step content), which the
 * specialist agent emits as structured Markdown — headings, code blocks,
 * tables, lists. Rendering it as plain text (the previous `LongText` path)
 * left the `#`/` ``` `/`|` markers visible and the report unreadable. This
 * wraps `MarkdownRenderer` (GFM tables + code + KaTeX, HTML stripped) in the
 * same expand/collapse affordance `LongText` gives plain fields, so a long
 * report is collapsed to a few lines by default and opens on demand. `content`
 * may also be a plain error string or the backend's no-text fallback — both
 * render fine as Markdown (plain text passes through unchanged).
 */
function MarkdownSection({ title, content, maxLines = 6 }: { title: string; content: unknown; maxLines?: number }) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const text = typeof content === "string" ? content : typeof content === "number" ? String(content) : "";
  // A max-line budget as a pixel height cap (12px font * 1.5 line-height), plus
  // the box's vertical padding (8px top + 8px bottom) so the cap measures the
  // same number of content lines regardless of the border/padding.
  const collapsedMaxHeight = maxLines * 18 + 16;
  // Measure overflow only while collapsed — mirrors LongText's sticky flag so
  // expanding never re-measures and drops the toggle.
  useLayoutEffect(() => {
    if (expanded) return;
    const el = ref.current;
    if (!el) return;
    setOverflow(el.scrollHeight - el.clientHeight > 1);
  }, [text, expanded]);
  if (!text) return null;
  return <section className="node-detail-section">
    <h4 className="node-detail-section-label">{title}</h4>
    <div
      ref={ref}
      className={expanded ? "markdown-body node-subagent-summary node-subagent-summary-expanded" : "markdown-body node-subagent-summary"}
      style={{ maxHeight: expanded ? "none" : `${collapsedMaxHeight}px` }}
    >
      <MarkdownRenderer content={text} />
    </div>
    {overflow ? <button className="node-longtext-toggle" onClick={() => setExpanded((e) => !e)} type="button">
      {expanded ? t("node.longtext.collapse") : t("node.longtext.expand")}
    </button> : null}
  </section>;
}

/** The searched run's node, reached over the ToolCall's `searches` edge. */
function searchRunOf(node: MemoryGraphNode, subgraph: MemorySubgraph): MemoryGraphNode | undefined {
  const edge = subgraph.edges.find((e) => e.source === node.id && e.type === "searches");
  if (!edge) return undefined;
  return subgraph.nodes.find((n) => n.id === edge.target && n.label === "SearchRun");
}

/** Scores, budget and a way into the panel — shared by the evolve ToolCall and
 *  the SearchRun node so the two views of one search cannot drift. */
function EvolveRunSummary({ extra, onOpenEvolveRun, runId }: {
  extra: Record<string, unknown>;
  onOpenEvolveRun?: (runId: string) => void;
  runId?: string;
}) {
  const { t } = useLocale();
  const number = (key: string) => (typeof extra[key] === "number" ? (extra[key] as number) : undefined);
  const baseline = number("baseline_score");
  const bestTest = number("best_test_score");
  return <>
    <dl className="node-detail-fields">
      {typeof extra.algorithm === "string" ? <Field label={t("evolve.summary.algorithm")} value={extra.algorithm} /> : null}
      {baseline !== undefined ? <Field label={t("node.evolve.baseline")} value={baseline.toFixed(4)} /> : null}
      {bestTest !== undefined ? <Field label={t("node.evolve.bestTest")} value={bestTest.toFixed(4)} /> : null}
      {number("candidates") !== undefined ? <Field label={t("node.evolve.candidates")} value={number("candidates")} /> : null}
      {number("tokens") !== undefined ? <Field label={t("evolve.summary.tokens")} value={number("tokens")} /> : null}
    </dl>
    {onOpenEvolveRun && runId ? <button
      className="node-evolve-open"
      onClick={() => onOpenEvolveRun(runId)}
      type="button"
    >{t("node.evolve.openPanel")}</button> : null}
  </>;
}

function TaskDetail({ extra, node, onOpenEvolveRun, scopeChildCount, subgraph }: {
  extra: Record<string, unknown>;
  node?: MemoryGraphNode;
  onOpenEvolveRun?: (runId: string) => void;
  scopeChildCount?: number;
  subgraph?: MemorySubgraph;
}) {

  const { t } = useLocale();
  const status = typeof extra.status === "string" ? extra.status : undefined;
  // Task (scope) carries ``task_type``; ToolCall carries ``tool_type``
  // instead (the post-rename field; pre-rename ToolCall nodes used
  // ``task_type``). Read both keys so the render branch below picks the
  // right one for whichever label landed on the node.
  const taskType = typeof extra.task_type === "string" ? extra.task_type : undefined;
  const toolType = typeof extra.tool_type === "string" ? extra.tool_type : undefined;
  const taskTypeDisplay = taskType ? taskTypeLabel(taskType, t) : undefined;
  // ToolCall's classification lives on tool_type post-rename; pre-rename
  // nodes still carry the old task_type key. Fall back to it so a legacy
  // node's "tool type" field renders instead of going blank (no migration
  // runs, so the legacy key is the only source for those nodes).
  const classification = toolType ?? taskType;
  const toolTypeDisplay = classification ? taskTypeLabel(classification, t) : undefined;
  // An evolve ToolCall's substance lives one edge away, on the SearchRun it
  // searches: scores, candidates, budget. Without this the node showed a bare
  // status and the panel that could explain it was unreachable from here.
  const searchRun = classification === "program_evolution" && node && subgraph
    ? searchRunOf(node, subgraph) : undefined;
  const evolveRunId = node?.id.startsWith("subtask:evolve:")
    ? node.id.slice("subtask:evolve:".length)
    : undefined;
  // A subagent scope (Task, task_type='subagent') carries its own descriptive
  // surface — objective, summary, role (subagent_type), child-task count —
  // distinct from the per-tool fields a ToolCall (tool_type=execution/search/…)
  // shows. Branch on task_type so the scope's card reads
  // as a scope, not as a generic task. The Task node still carries
  // task_type (the Task field is unchanged); a ToolCall never sets it
  // the post-rename field is ``tool_type``), so the scope check is naturally
  // false for the ToolCall branch.
  const isScope = taskType === "subagent";
  const objective = extra.objective;
  const summary = extra.summary;
  const subagentType = typeof extra.subagent_type === "string" && extra.subagent_type ? extra.subagent_type : undefined;
  const failureReason = typeof extra.failure_reason === "string" && extra.failure_reason ? extra.failure_reason : undefined;
  if (isScope) {
    return <div className="node-detail-body">
      {status ? <span className={`node-status-badge node-status-${status}`}>{status}</span> : null}
      {objective ? <MarkdownSection title={t("node.section.subagent_objective")} content={objective} maxLines={4} /> : null}
      {summary ? <MarkdownSection title={t("node.section.subagent_summary")} content={summary} maxLines={6} /> : null}
      <dl className="node-detail-fields">
        {/* Scope (Task) still carries task_type; the field label key was renamed
            from ``node.field.task_type`` to ``node.field.tool_type`` — the
            value here is still the Task's task_type ('subagent'). */}
        {taskTypeDisplay ? <Field label={t("node.field.tool_type")} value={taskTypeDisplay} /> : null}
        {subagentType ? <Field label={t("node.field.subagent_type")} value={subagentType} /> : null}
        {typeof scopeChildCount === "number" ? <Field label={t("node.field.child_count")} value={scopeChildCount} /> : null}
        {failureReason ? <Field label={t("node.field.failure_reason")} value={failureReason} /> : null}
        {extra.created_at ? <Field label={t("node.field.created_at")}><TimeField value={extra.created_at} /></Field> : null}
        {extra.finished_at ? <Field label={t("node.field.finished_at")}><TimeField value={extra.finished_at} /></Field> : null}
      </dl>
    </div>;
  }
  return <div className="node-detail-body">
    {status ? <span className={`node-status-badge node-status-${status}`}>{status}</span> : null}
    <dl className="node-detail-fields">
      {/* tool_name is the full tool identifier
          (e.g. ``mcp__arxiv__search`` / ``run_shell``). Surfaced first so the
          reader sees the actual tool that was called before any classification
          detail. Pre-rename nodes have no tool_name (no migration backfills
          them), so this field is simply absent on legacy nodes. */}
      {typeof extra.tool_name === "string" && extra.tool_name
        ? <Field label={t("node.field.tool_name")} value={extra.tool_name} /> : null}
      {/* tool_type is the coarse classification
          (execution / search, or the evolve marker program_evolution) — the
          field formerly labelled ``node.field.task_type`` before the
          rename. Legacy values are folded by ``taskTypeLabel``. */}
      {toolTypeDisplay ? <Field label={t("node.field.tool_type")} value={toolTypeDisplay} /> : null}
      {typeof extra.source === "string" && extra.source ? <Field label={t("node.field.source")} value={extra.source} /> : null}
      {extra.finished_at ? <Field label={t("node.field.finished_at")}><TimeField value={extra.finished_at} /></Field> : null}
      {extra.created_at ? <Field label={t("node.field.created_at")}><TimeField value={extra.created_at} /></Field> : null}
      {typeof extra.result_count === "number" ? <Field label={t("node.field.result_count")} value={extra.result_count} /> : null}
    </dl>
    {searchRun || evolveRunId ? <EvolveRunSummary
      extra={(searchRun?.extra ?? {}) as Record<string, unknown>}
      onOpenEvolveRun={onOpenEvolveRun}
      runId={evolveRunId}
    /> : null}
  </div>;
}

// --- Paper ------------------------------------------------------------------

function PaperDetail({ extra }: { extra: Record<string, unknown> }) {
  const { t } = useLocale();
  const title = typeof extra.title === "string" ? extra.title : undefined;
  const abstract = extra.abstract;
  const authors = Array.isArray(extra.authors) ? extra.authors : undefined;
  const link = extra.link;
  const source = extra.source;
  const retrievedCount = extra.retrieval_count;
  const retrievedAt = extra.retrieved_at;
  const createdAt = extra.created_at;
  return <div className="node-detail-body">
    {title ? <h4 className="node-detail-title">{title}{typeof extra.year === "string" ? <span className="node-detail-year"> ({extra.year})</span> : null}</h4> : null}
    {abstract ? <section className="node-detail-section">
      <h5 className="node-detail-section-label">{t("node.section.abstract")}</h5>
      <LongText value={abstract} maxLines={6} />
    </section> : null}
    <dl className="node-detail-fields">
      {authors?.length ? <Field label={t("node.field.authors")}><span>{authors.join(", ")}</span></Field> : null}
      {source ? <Field label={t("node.field.source")} value={source} /> : null}
      {link ? <Field label={t("node.field.source_link")}><LinkField href={link} /></Field> : null}
      {typeof retrievedCount === "number" ? <Field label={t("node.field.retrieval_count")}>
        <span>{retrievedCount} {t("node.unit.times")}</span>
      </Field> : null}
      {retrievedAt ? <Field label={t("node.field.last_retrieved")}><TimeField value={retrievedAt} /></Field> : null}
      {createdAt ? <Field label={t("node.field.created_at")}><TimeField value={createdAt} /></Field> : null}
    </dl>
  </div>;
}

// --- WebPage / DbRecord detail surface -----------------------------------

/**
 * A small clickable badge for the database identifier on a DbRecord node.
 * Renders `source:identifier` when both are known, falls back to just the
 * identifier, and stays empty when neither is present. The whole pill is the
 * button — no separate icon trailing the text — so the copy affordance is
 * obvious at a glance and the text stays single-line. A leading “复制标识符”
 * / “Copy identifier” label primes the click, and a 1.5s checkmark on the
 * prefix confirms success. Falls back to a hidden textarea + execCommand
 * when the async clipboard API is blocked (e.g. insecure context); silently
 * no-ops otherwise rather than showing a misleading checkmark.
 */
function DbRecordIdentifierBadge({ source, identifier }: { source?: string; identifier?: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  if (!identifier) return null;
  const display = source ? `${source}:${identifier}` : identifier;
  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(identifier);
      setCopied(true);
    } catch {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = identifier;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        setCopied(true);
      } catch {
        // Clipboard unavailable — keep the badge as-is rather than showing a
        // misleading checkmark.
      }
    }
  };
  const feedback = copied ? t("copy.copied") : t("node.identifier_badge.copy");
  return (
    <button
      type="button"
      className={`node-identifier-badge node-identifier-badge-button${copied ? " copied" : ""}`}
      onClick={() => void onCopy()}
      aria-label={feedback}
      title={feedback}
    >
      <span className="node-identifier-badge-prefix">{feedback}</span>
      <span className="node-identifier-badge-text">{display}</span>
    </button>
  );
}

/**
 * WebPage: one row per ``web_search`` / ``llm-wiki__search`` hit. Layout
 * mirrors PaperDetail (title + content section + snippet section + field strip)
 * but the link is the URL itself (no separate link field), identifier renders
 * as a small badge instead of a Field row, and an "Original References" list
 * surfaces when present. The body ships in the CAS data pool, addressed
 * by ``extra.content_hash``, and the card reads it back via
 * ``readWebPageContent`` to render the "Full Text" section. When
 * ``content_hash`` is absent (a snippet-only search hit), the card falls
 * back to the source link so the user can still get to the page.
 *
 * Exported so EvidenceModal's Provenance tab can render a WebPage-backed
 * evidence's source with the same card the explorer shows: the header links
 * to the page and the Full Text section reads the body back from CAS. A
 * WebPage reaches an Evidence over the same ``extracts`` edge as a Paper or
 * a SourceFile, so the modal needs the same three surfaces; duplicating this
 * card there would have to re-derive its hash gate, preamble stripping and
 * error mapping by hand.
 */
export function WebPageDetail({
  extra,
  client,
  sessionId,
  webPageId,
}: {
  extra: Record<string, unknown>;
  client: ApiClient;
  sessionId: string;
  webPageId: string;
}) {
  const { t } = useLocale();
  const title = typeof extra.title === "string" && extra.title.trim() ? extra.title : undefined;
  const identifier = typeof extra.identifier === "string" && extra.identifier.trim() ? extra.identifier : undefined;
  const identifierType = typeof extra.identifier_type === "string" && extra.identifier_type.trim()
    ? extra.identifier_type : undefined;
  const url = typeof extra.url === "string" && extra.url.trim() ? extra.url : undefined;
  // title's fallback chain: title → identifier (wiki path) → url (last resort).
  // The url comes last because a long URL would dominate the header.
  const fallback = identifier ?? url;
  const snippet = typeof extra.snippet === "string" && extra.snippet ? extra.snippet : undefined;
  const sourceRefs = Array.isArray(extra.source_refs)
    ? (extra.source_refs as unknown[]).filter((v): v is string => typeof v === "string" && !!v.trim())
    : undefined;
  const retrievalCount = typeof extra.retrieval_count === "number" ? extra.retrieval_count : undefined;
  const retrievedAt = extra.retrieved_at;
  const createdAt = extra.created_at;
  // The body lives in the CAS data pool: the broker writes content_hash onto
  // the node, and the bytes are addressed by that hash. The card fetches
  // them lazily on mount so a session with many WebPages does not pull
  // every body up front. ``has_full_content`` is a redundant hint also
  // persisted; the hash presence is the real gate — content_hash is set
  // iff the body is in CAS, so guarding on it covers the "snippet-only
  // hit" case naturally.
  const contentHash = typeof extra.content_hash === "string" && /^[a-f0-9]{64}$/.test(extra.content_hash)
    ? extra.content_hash
    : undefined;
  const showTitle = title ?? fallback;
  return <div className="node-detail-body">
    {/* The header IS the link to the page — the card used to follow it with a
        standalone URL row pointing at the same target, which for a page with
        no title repeated the exact text this header already showed. A page
        with no url keeps a plain (unlinked) title. */}
    {showTitle ? <h4 className="node-detail-title">
      {url ? <LinkField href={url}>{showTitle}</LinkField> : showTitle}
    </h4> : null}
    {/* WebPage's identifier badge mirrors DbRecord's pattern but carries no
        copy affordance here — wiki paths are usually the URL itself, and the
        header above is the natural way to follow it. The badge exists so
        readers can see the identifier_type at a glance (e.g. ``wiki-path``). */}
    {identifier ? <div className="node-detail-row">
      <span className="node-identifier-badge node-identifier-badge-plain">
        <span className="node-identifier-badge-text">
          {identifierType ? `${identifierType}:${identifier}` : identifier}
        </span>
      </span>
    </div> : null}
    {contentHash ? <ContentSection
      client={client}
      contentHash={contentHash}
      sessionId={sessionId}
      webPageId={webPageId}
    /> : url ? <section className="node-detail-section">
      {/* Snippet-only WebPage: no body in CAS yet, so the card guides the
          reader to the source. Once a get_page/web_fetch mirrors a
          content_hash onto the node, this branch disappears and the
          ContentSection takes over. */}
      <h5 className="node-detail-section-label">{t("node.field.not_retrieved")}</h5>
      <LinkField href={url}>{t("node.field.view_source")}</LinkField>
    </section> : null}
    {snippet ? <section className="node-detail-section">
      <h5 className="node-detail-section-label">{t("node.field.snippet")}</h5>
      {/* Markdown-rendered, like the Task scope's summary: a search snippet
          may contain light Markdown (bold names, occasional italics), and a
          raw text dump would surface stray asterisks. maxLines=4 keeps the
          snippet preview compact while the expand toggle handles long ones. */}
      <MarkdownSection title="" content={snippet} maxLines={4} />
    </section> : null}
    {sourceRefs?.length ? <section className="node-detail-section">
      <h5 className="node-detail-section-label">{t("node.field.source_refs")}</h5>
      <ul className="node-source-refs">
        {sourceRefs.map((ref, idx) => <li key={`${idx}-${ref}`}>{ref}</li>)}
      </ul>
    </section> : null}
    <dl className="node-detail-fields">
      {typeof retrievalCount === "number" ? <Field label={t("node.field.retrieval_count")}>
        <span>{retrievalCount} {t("node.unit.times")}</span>
      </Field> : null}
      {retrievedAt ? <Field label={t("node.field.retrieved_at")}><TimeField value={retrievedAt} /></Field>
        : createdAt ? <Field label={t("node.field.retrieved_at")}><TimeField value={createdAt} /></Field> : null}
      {createdAt ? <Field label={t("node.field.created_at")}><TimeField value={createdAt} /></Field> : null}
    </dl>
  </div>;
}

/** Strip minimal HTML so the MarkdownSection below doesn't leak raw tags into
 *  the card. The CAS data pool stores page bodies verbatim (HTML or text), so
 *  we have to scrub before rendering. Conservative: only strip <script>/<style>
 *  blocks wholesale + tag the rest + decode the four most common entities. No
 *  entity re-encoding of arbitrary user content — the body itself is plain
 *  text from the upstream page, not a Markdown source, so we don't need to
 *  round-trip through HTML escape. */
function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Drop the page reader's wrapper from a body before it is rendered.
 *
 *  The web-fetch tool wraps every body it returns in a short preamble —
 *  ``Title:``, ``URL Source: <url>``, ``Markdown Content:`` — and we persist
 *  the tool result verbatim, so the wrapper is the first thing in the CAS
 *  blob. None of it is page text: ``URL Source`` repeats the URL the card's
 *  header already links to, ``Title`` is usually empty (the node's own title
 *  field is the real source), and ``Markdown Content:`` is a separator.
 *
 *  Only a contiguous run of those labels at the very top is dropped, blank
 *  lines inside the run included, so a page that writes "URL Source:" five
 *  paragraphs down keeps its text. */
function stripReaderPreamble(input: string): string {
  const lines = input.split("\n");
  let i = 0;
  let dropped = 0;
  for (; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    if (!/^(?:Title|URL Source|Markdown Content):/.test(line)) break;
    dropped += 1;
  }
  if (!dropped) return input;
  // The blanks the wrapper left behind go with it, or the body would start
  // with an empty paragraph.
  while (i < lines.length && !(lines[i] ?? "").trim()) i += 1;
  return lines.slice(i).join("\n").trim();
}

/** Lazy "Full Text" section for a WebPage whose body lives in CAS. Three
 *  states: loading ("…" field), error (the read failed), and resolved (the
 *  MarkdownSection renders the body). The fetch is keyed on (sessionId,
 *  webPageId, contentHash) so a hash change re-fetches; cleanup uses the
 *  ``cancelled`` flag because the component can unmount while the fetch is
 *  still in flight (panel switch, modal close). */
function ContentSection({
  client,
  sessionId,
  webPageId,
  contentHash,
}: {
  client: ApiClient;
  sessionId: string;
  webPageId: string;
  contentHash: string;
}) {
  const { t } = useLocale();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    client.readWebPageContent(sessionId, webPageId)
      .then((body) => {
        if (cancelled) return;
        setText(stripReaderPreamble(stripHtml(body)));
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        // 404 means the body really is missing — surface a softer "not
        // retrieved" message rather than a hard error, so the card doesn't
        // look broken for an old snippet-only WebPage.
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(/not available/i.test(message) ? t("node.field.not_retrieved") : `${t("node.field.content_error")}: ${message}`);
      });
    return () => { cancelled = true; };
  }, [client, sessionId, webPageId, contentHash, t]);
  if (error) return <section className="node-detail-section">
    <h5 className="node-detail-section-label">{t("node.field.content")}</h5>
    <Field label={t("node.field.content_error")} value={error} />
  </section>;
  if (text === null) return <section className="node-detail-section">
    <h5 className="node-detail-section-label">{t("node.field.content")}</h5>
    <Field label={t("node.field.content_loading")} value="…" />
  </section>;
  // A returned-but-empty body is rendered as an empty section header so the
  // reader sees "Full Text" is present but nothing further was retrieved —
  // same intent as the snippet-only branch, but no link to fall back to.
  if (!text) return <section className="node-detail-section">
    <h5 className="node-detail-section-label">{t("node.field.content")}</h5>
    <Field label={t("node.field.not_retrieved")} value="…" />
  </section>;
  return <section className="node-detail-section">
    <h5 className="node-detail-section-label">{t("node.field.content")}</h5>
    {/* maxLines=20 keeps a 400-line page from blowing up the card height; the
        MarkdownSection's built-in expand toggle surfaces the rest. The body
        may contain Markdown from the source page (lists, links), so render
        it as Markdown rather than plain text — same affordance as the
        snippet section above. */}
    <MarkdownSection title="" content={text} maxLines={20} />
  </section>;
}

/**
 * DbRecord: one row per database search hit. Differs from WebPage in three
 * places: the title is always the curator's chosen name (no fallback to
 * URL), the identifier badge is interactive (click → copy accession), and
 * ``source`` is not rendered as its own field — it only participates in
 * dedup; the badge uses it as a prefix so two databases' "P38398" don't
 * read identically.
 */
function DbRecordDetail({ extra }: { extra: Record<string, unknown> }) {
  const { t } = useLocale();
  const title = typeof extra.title === "string" && extra.title.trim() ? extra.title : undefined;
  const source = typeof extra.source === "string" && extra.source.trim() ? extra.source : undefined;
  const identifier = typeof extra.identifier === "string" && extra.identifier.trim() ? extra.identifier : undefined;
  const url = typeof extra.url === "string" && extra.url.trim() ? extra.url : undefined;
  const snippet = typeof extra.snippet === "string" && extra.snippet ? extra.snippet : undefined;
  const retrievalCount = typeof extra.retrieval_count === "number" ? extra.retrieval_count : undefined;
  const retrievedAt = extra.retrieved_at;
  const createdAt = extra.created_at;
  return <div className="node-detail-body">
    {title ? <h4 className="node-detail-title">{title}</h4> : null}
    <DbRecordIdentifierBadge source={source} identifier={identifier} />
    {snippet ? <section className="node-detail-section">
      <h5 className="node-detail-section-label">{t("node.field.snippet")}</h5>
      <MarkdownSection title="" content={snippet} maxLines={4} />
    </section> : null}
    <dl className="node-detail-fields">
      {url ? <Field label={t("node.field.record_link")}><LinkField href={url} /></Field> : null}
      {typeof retrievalCount === "number" ? <Field label={t("node.field.retrieval_count")}>
        <span>{retrievalCount} {t("node.unit.times")}</span>
      </Field> : null}
      {retrievedAt ? <Field label={t("node.field.retrieved_at")}><TimeField value={retrievedAt} /></Field>
        : createdAt ? <Field label={t("node.field.retrieved_at")}><TimeField value={createdAt} /></Field> : null}
      {createdAt ? <Field label={t("node.field.created_at")}><TimeField value={createdAt} /></Field> : null}
    </dl>
  </div>;
}

// --- SourceFile (an uploaded input file) -----------------------------------

function SourceFileDetail({ extra }: { extra: Record<string, unknown> }) {
  const { t } = useLocale();
  // `content_hash` is deliberately not rendered — it is a routing key for the
  // CAS, not something a reviewer reads off the card.
  const name = typeof extra.name === "string" ? extra.name : undefined;
  const path = typeof extra.path === "string" ? extra.path : undefined;
  const mediaType = typeof extra.media_type === "string" ? extra.media_type : undefined;
  const size = typeof extra.size === "number" ? extra.size : undefined;
  const createdAt = extra.created_at;
  return <div className="node-detail-body">
    {name ? <h4 className="node-detail-title">{name}</h4> : null}
    <dl className="node-detail-fields">
      {path ? <Field label={t("node.field.path")} value={path} /> : null}
      {mediaType ? <Field label={t("node.field.media_type")} value={mediaType} /> : null}
      {typeof size === "number" ? <Field label={t("node.field.size")}><span>{size.toLocaleString()} {t("node.unit.bytes")}</span></Field> : null}
      {createdAt ? <Field label={t("node.field.created_at")}><TimeField value={createdAt} /></Field> : null}
    </dl>
  </div>;
}

// --- Evidence ---------------------------------------------------------------

function EvidenceDetail({ extra }: { extra: Record<string, unknown> }) {
  const { t } = useLocale();
  // Mirrors EvidenceModal's partition so Explorer-click and report-chip-click
  // present the same content/meta structure.
  const { contentNodes, metaPairs } = partitionEvidenceExtra(extra);
  const sourcePaperLink = typeof extra.source_paper_link === "string" ? extra.source_paper_link : undefined;
  // Per-key i18n for the meta/content buckets; falls back to humanizeKey for
  // any future field not yet covered, so nothing renders as a raw snake_case.
  const labelFor = (key: string): string => {
    switch (key) {
      case "content": return t("node.field.content");
      case "source_excerpt": return t("node.field.source_excerpt");
      case "confidence": return t("node.field.confidence");
      case "locator": return t("node.field.citation_locator");
      default: return humanizeKey(key);
    }
  };
  return <div className="node-detail-body">
    {contentNodes.length ? <section className="evidence-content">
      {contentNodes.map(({ key, value }) => <div key={key}>
        <h5 className="evidence-content-label">{labelFor(key)}</h5>
        <LongText value={value} maxLines={8} />
      </div>)}
    </section> : null}
    {metaPairs.length ? <dl className="evidence-meta">
      {metaPairs.map(({ key, value }) => <div className="evidence-meta-prop" key={key}>
        <dt>{labelFor(key)}</dt>
        <dd>{typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value)}</dd>
      </div>)}
    </dl> : null}
    {sourcePaperLink ? <dl className="node-detail-fields">
      <Field label={t("node.field.source_paper")}><LinkField href={sourcePaperLink} /></Field>
    </dl> : null}
  </div>;
}

// --- Claim ------------------------------------------------------------------

function ClaimDetail({ extra }: { extra: Record<string, unknown> }) {
  const { t } = useLocale();
  const content = extra.content;
  return <div className="node-detail-body">
    {content ? <section className="node-detail-section">
      <h4 className="node-detail-section-label">{t("node.field.claim_body")}</h4>
      <LongText value={content} maxLines={8} />
    </section> : null}
    <dl className="node-detail-fields">
      {extra.confidence ? <Field label={t("node.field.confidence")} value={extra.confidence} /> : null}
      {extra.created_at ? <Field label={t("node.field.created_at")}><TimeField value={extra.created_at} /></Field> : null}
    </dl>
  </div>;
}

// --- Code (client needed to recover script + stdout/stderr via provenance) -

function CodeDetail({ node, client, sessionId, subgraph }: {
  node: MemoryGraphNode;
  client: ApiClient;
  sessionId: string;
  subgraph: MemorySubgraph;
}) {
  const extra = (node.extra ?? {}) as Record<string, unknown>;
  const [code, setCode] = useState<string>();
  const [stdout, setStdout] = useState<string>();
  const [stderr, setStderr] = useState<string>();
  const [env, setEnv] = useState<EnvironmentRevision[]>();
  const [note, setNote] = useState<string>();

  // Recover the script AND execution log (stdout/stderr). Two paths, tried in
  // order — both end at the same CAS bytes, so the recovered content matches:
  //  A) produced-artifact path: the Code -produces-> an Artifact whose
  //     provenance already bundles code/stdout/stderr/env in one call.
  //  B) run path (fallback): a Code node that produced no Artifact still has
  //     code_id = executionId; the ExecutionRun itself carries code/stdout/
  //     stderr as CAS hashes, fetched directly via /api/cas/{hash}. Before this
  //     fallback, any produces-less Code node showed "cannot be recovered" even
  //     when the run genuinely ran code — the note is now a last resort, not the
  //     default.
  const producedNode = subgraph.nodes.find((candidate) => candidate.label === "Artifact"
    && subgraph.edges.some((edge) => edge.source === node.id && edge.type === "produces" && edge.target === candidate.id));
  const lookupKey = JSON.stringify({
    produced: producedNode
      ? [producedNode.extra?.path ?? null, producedNode.extra?.artifact_id ?? null, producedNode.id]
      : null,
    runId: typeof extra.code_id === "string" ? extra.code_id : node.id,
  });

  useEffect(() => {
    setCode(undefined); setStdout(undefined); setStderr(undefined); setEnv(undefined); setNote(undefined);
    if (!lookupKey) return;
    let active = true;
    const { produced, runId } = JSON.parse(lookupKey) as { produced: Array<string | null> | null; runId: string };
    void (async () => {
      try {
        if (produced) {
          // Path A — produced-artifact provenance (script + logs + env in one).
          const wanted = produced.filter((value): value is string => typeof value === "string" && !!value.trim());
          const artifacts = await client.listArtifacts(sessionId);
          // Prefer id match — wanted carries extra.artifact_id; logicalName
          // alone misresolves across same-named sessions (see useResolvedArtifactName).
          const match = artifacts.find((candidate) => wanted.includes(candidate.id))
            ?? artifacts.find((candidate) => wanted.some((value) =>
              candidate.logicalName === value || candidate.logicalName.endsWith(`/${value}`)));
          if (!match) { if (active) setNote(translateActive("memory.code.artifactGone")); return; }
          const versions = await client.listArtifactVersions(sessionId, match.id);
          const versionId = versions.at(-1)?.id;
          if (!versionId) { if (active) setNote(translateActive("memory.code.artifactGone")); return; }
          const provenance = await client.getArtifactProvenance(sessionId, versionId);
          if (!active) return;
          const codeEntry = provenance.code.find((item) => item.runId === runId) ?? provenance.code[0];
          if (codeEntry) setCode(codeEntry.code);
          // executionLog is keyed by runId too; match the same run to surface its
          // stdout/stderr alongside the script.
          const logEntry = provenance.executionLog.find((log) => log.runId === runId) ?? provenance.executionLog[0];
          if (logEntry) {
            if (logEntry.stdout) setStdout(logEntry.stdout);
            if (logEntry.stderr) setStderr(logEntry.stderr);
          }
          // Environment snapshot (language/packages/platform/provisioner) — the
          // graph stores only env_hash (a CAS address), so the real content is
          // recovered from the provenance environments block, same as
          // code/stdout/stderr.
          if (provenance.environments?.length) setEnv(provenance.environments);
          if (!codeEntry && !logEntry) setNote(translateActive("memory.code.noScriptOrLog"));
          return;
        }
        // Path B — no produced artifact; recover straight from the ExecutionRun
        // (code_id = executionId) via CAS. A run that genuinely has no script or
        // no output is the only case that lands a note here.
        const runs = await client.listExecutionRuns(sessionId);
        if (!active) return;
        const run = runs.find((candidate) => candidate.id === runId);
        if (!run) { if (active) setNote(translateActive("memory.code.noScriptOrLog")); return; }
        const results = await Promise.allSettled([
          run.code?.hash ? client.readCas(run.code.hash) : Promise.resolve(""),
          run.stdout?.hash ? client.readCas(run.stdout.hash) : Promise.resolve(""),
          run.stderr?.hash ? client.readCas(run.stderr.hash) : Promise.resolve(""),
        ]);
        if (!active) return;
        const codeText = results[0].status === "fulfilled" ? results[0].value : "";
        const stdoutText = results[1].status === "fulfilled" ? results[1].value : "";
        const stderrText = results[2].status === "fulfilled" ? results[2].value : "";
        if (codeText) setCode(codeText);
        if (stdoutText) setStdout(stdoutText);
        if (stderrText) setStderr(stderrText);
        // Environment snapshot: resolve run.environmentRevisionId against the
        // shared environment catalog (one GET), the same EnvironmentRevision[]
        // shape path A yields from provenance.environments — so the env block
        // renders identically whether or not the run produced an artifact.
        // Shell runs (run_shell) carry no environmentRevisionId and so render no
        // env block, matching path A where the graph stored env_hash=null.
        if (run.environmentRevisionId) {
          try {
            const revisions = await client.listEnvironmentRevisions();
            if (!active) return;
            const revision = revisions.find((candidate) => candidate.id === run.environmentRevisionId);
            if (revision) setEnv([revision]);
          } catch {
            // Environment catalog fetch is best-effort; a missing env block is
            // not a reason to drop the already-recovered code/logs.
          }
        }
        if (!codeText && !stdoutText && !stderrText) setNote(translateActive("memory.code.noScriptOrLog"));
      } catch (error) {
        if (active) setNote(error instanceof Error ? error.message : translateActive("memory.code.loadFailed"));
      }
    })();
    return () => { active = false; };
  }, [client, lookupKey, sessionId]);

  const { t } = useLocale();
  const status = typeof extra.status === "string" ? extra.status : undefined;

  return <div className="node-detail-body">
    {status ? <span className={`node-status-badge node-status-${status}`}>{status}</span> : null}
    {code ? <section className="node-detail-section">
      <h5 className="node-detail-section-label">{t("node.field.script")}</h5>
      <pre className="artifact-source-preview">{code}</pre>
    </section> : null}
    <dl className="node-detail-fields">
      {extra.tool ? <Field label={t("node.field.tool")} value={extra.tool} /> : null}
      {extra.language ? <Field label={t("node.field.language")} value={extra.language} /> : null}
      {extra.exit_code !== undefined && extra.exit_code !== null ? <Field label={t("node.field.exit_code")} value={extra.exit_code} /> : null}
      {extra.started_at ? <Field label={t("node.field.run_time")}>
        <span>{<TimeField value={extra.started_at} />}{extra.finished_at ? " → " : null}{extra.finished_at ? <TimeField value={extra.finished_at} /> : null}</span>
      </Field> : null}
    </dl>
    {(stdout || stderr) ? <section className="node-detail-section">
      <h5 className="node-detail-section-label">{t("node.field.execution_output")}</h5>
      {/* stdout/stderr rendered as a <pre> with the same background-frame class
          the script uses, so execution output reads like a terminal block
          rather than a flat paragraph. */}
      {stdout ? <div className="node-detail-output"><h6 className="node-detail-output-label">{t("node.field.stdout")}</h6><pre className="artifact-source-preview">{stdout}</pre></div> : null}
      {stderr ? <div className="node-detail-output node-detail-output-err"><h6 className="node-detail-output-label">{t("node.field.stderr")}</h6><pre className="artifact-source-preview">{stderr}</pre></div> : null}
    </section> : null}
    {env?.length ? <section className="node-detail-section">
      <h5 className="node-detail-section-label">{t("node.field.environment")}</h5>
      {env.map((environment) => <article className="provenance-env" key={environment.id}>
        <header><strong>{environment.language} {environment.languageVersion}</strong></header>
        <p>{environment.provisioner} · {environment.platform}</p>
        <small>{environment.packages.join(", ") || t("node.field.environment")}</small>
      </article>)}
    </section> : null}
    {note ? <p className="artifact-empty compact">{note}</p> : null}
  </div>;
}

// --- Fallback (unknown label, or a typed component fell through) -----------

function RawNodeProperties({ extra }: { extra: Record<string, unknown> }) {
  const { t } = useLocale();
  const nonEmpty = Object.entries(extra).filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!nonEmpty.length) return <p className="artifact-empty compact">{t("memory.node.noProperties")}</p>;
  return <dl className="memory-graph-detail-props">
    {nonEmpty.map(([key, value]) => <div className="memory-graph-detail-prop" key={key}>
      <dt>{key}</dt>
      <dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
    </div>)}
  </dl>;
}

/**
 * Left-column fallback for nodes that are not artifacts (Task, ToolCall, Code,
 * Paper, …): shows the node's header, its outgoing relationships, and delegates
 * the property surface to the per-label detail component (which recovers
 * script / logs for Code nodes, formats times/links, and truncates long text).
 */
export function MemoryGraphNodeDetail({
  client,
  node,
  onOpenEvolveRun,
  onSelectNode,
  resolveState,
  sessionId,
  subgraph,
  scopeChildCounts,
}: {
  client: ApiClient;
  node?: MemoryGraphNode;
  /** Open the evolve panel for a run this node points at. Omit where the
   *  panel is out of reach (a modal without the session's run list). */
  onOpenEvolveRun?: (runId: string) => void;
  /** Follow a relationship to its target node. Omit to render the chips as plain text. */
  onSelectNode?: (nodeId: string) => void;
  resolveState: ResolveState;
  sessionId: string;
  subgraph: MemorySubgraph;
  /** True per-scope child counts (built from the raw folded node set in the
   *  explorer), so the scope detail card can show the child-task count even
   *  while the scope is collapsed — counting visible ``contains`` edges would
   *  read 0 while folded. */
  scopeChildCounts?: ReadonlyMap<string, number>;
}) {
  const { t } = useLocale();
  if (!node) {
    return <div className="memory-product memory-product-idle">
      <p className="artifact-empty compact">{t("node.idle.prompt")}</p>
    </div>;
  }

  // Outgoing edges grouped by relationship. Listing them all under "produces"
  // misreports the graph: a Task/ToolCall *produces* its Code and runs *next*
  // before the following Task/ToolCall, and those are different claims.
  const relations = new Map<MemoryGraphEdgeType, MemoryGraphNode[]>();
  for (const edge of subgraph.edges) {
    if (edge.source !== node.id) continue;
    const target = subgraph.nodes.find((candidate) => candidate.id === edge.target);
    if (!target) continue;
    const bucket = relations.get(edge.type);
    if (bucket) bucket.push(target);
    else relations.set(edge.type, [target]);
  }
  // Display order: produces is the primary "this node made that" claim and
  // reads first; next is the temporal chain and reads beneath it. Others
  // follow the schema order; any unknown type lands last (large index).
  const edgeRank = (type: MemoryGraphEdgeType): number => {
    const i = EDGE_DISPLAY_ORDER.indexOf(type);
    return i === -1 ? EDGE_DISPLAY_ORDER.length : i;
  };
  const relationLabel = (type: MemoryGraphEdgeType): string => {
    const key = `node.relation.${type}` as const;
    const translated = t(key);
    return translated === key ? type.replaceAll("_", " ") : translated;
  };
  const orderedRelations = [...relations].sort((a, b) => edgeRank(a[0]) - edgeRank(b[0]));

  return <div className="memory-product">
    <header className="memory-product-header">
      <span className="memory-product-kind">{node.label}</span>
      {/* ResearchGoal's name is its core_objective, Paper's is its title, and
          Claim's is its claim_id UUID (no title/name field) — all three are
          already surfaced in the body (core objective / title / claim body),
          so the header only adds noise (a duplicate title for Paper, a bare
          hash for Claim). Other labels show their short name here. */}
      {node.label === "ResearchGoal" || node.label === "Paper" || node.label === "Claim" || node.label === "Evidence"
        || node.label === "WebPage" || node.label === "DbRecord"
        ? null
        : <strong title={graphNodeName(node)}>{graphNodeName(node)}</strong>}
    </header>
    <div className="memory-product-body">
      {node.label === "Artifact" && resolveState === "missing"
        ? <p className="artifact-empty compact">{t("node.artifact.missing")}</p> : null}
      {node.label === "Artifact" && resolveState === "loading"
        ? <p className="artifact-empty compact">{t("node.artifact.loading")}</p> : null}
      {orderedRelations.map(([type, targets]) => <div className="memory-product-links" key={type}>
        <span className="memory-product-links-label">{relationLabel(type)}</span>
        {targets.map((target) => onSelectNode
          // A relationship chip names a node that is right there in the graph;
          // make it the way to get there instead of asking the user to hunt for
          // the dot. Selecting also moves the canvas highlight.
          ? <button
            className="memory-product-link memory-product-link-action"
            key={`${type}:${target.id}`}
            onClick={() => onSelectNode(target.id)}
            title={t("node.relation.goto", { label: target.label, name: graphNodeName(target) })}
            type="button"
          >
            {target.label}: {graphNodeName(target)}
          </button>
          : <span className="memory-product-link" key={`${type}:${target.id}`}>
            {target.label}: {graphNodeName(target)}
          </span>)}
      </div>)}
      <NodeProperties node={node} client={client} onOpenEvolveRun={onOpenEvolveRun} sessionId={sessionId} subgraph={subgraph} scopeChildCounts={scopeChildCounts} />
    </div>
  </div>;
}
