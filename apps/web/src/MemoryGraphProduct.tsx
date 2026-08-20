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

import { useEffect, useState } from "react";

import type { EnvironmentRevision, MemoryGraphEdgeType, MemoryGraphNode, MemorySubgraph } from "@science-agent/schema";

import type { ApiClient } from "./api.js";
import { useLocale } from "./i18n/LocaleProvider.js";
import { graphNodeName } from "./MemoryGraphCanvas.js";
import { Field, humanizeKey, LinkField, LongText, partitionEvidenceExtra, TimeField } from "./NodeField.js";

/** Edge-type display order in the relations block: produces is the primary
 *  "this node made that" claim and reads first; next is the temporal chain
 *  (a sibling produced later) and reads beneath it. Others follow the schema
 *  order; any unknown type lands last. */
const EDGE_DISPLAY_ORDER: MemoryGraphEdgeType[] = ["produces", "next", "extracts", "supports", "stated_in", "supersedes", "input"];

export type ResolveState = "idle" | "loading" | "missing" | "resolved";

/**
 * Map a graph Artifact node onto a real session artifact's logical name, so the
 * shared artifacts panel can load it. The graph node carries both the
 * suffix-less workspace path and a precise artifact_id; we match on id first,
 * falling back to path/logicalName for legacy nodes that lack an id.
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
  const extra = node?.extra ?? {};
  const lookupKey = isArtifact
    ? JSON.stringify([node.id, extra.path ?? null, extra.artifact_id ?? null])
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
        // session's artifact (P2).
        const match = artifacts.find((candidate) => wanted.includes(candidate.id))
          ?? artifacts.find((candidate) => wanted.some((value) =>
            candidate.logicalName === value || candidate.logicalName.endsWith(`/${value}`)));
        // Only publish a change; re-resolving the same node must not churn the
        // name, or the embedded artifact panel unmounts and refetches.
        if (match) { setName(match.logicalName); setState("resolved"); }
        else { setName(undefined); setState("missing"); }
      })
      .catch(() => { if (active) { setName(undefined); setState("missing"); } });
    return () => { active = false; };
  }, [client, lookupKey, sessionId]);

  return { name, state };
}

/** Per-label detail view. Dispatches to a semantic component for each node
 *  type; falls back to the raw key/value dump for unknown labels. Each typed
 *  component composes the shared Field/LongText/TimeField/LinkField primitives
 *  so hashes decode, long text truncates, times format, links open. */
function NodeProperties({ node, client, sessionId, subgraph }: {
  node: MemoryGraphNode;
  client: ApiClient;
  sessionId: string;
  subgraph: MemorySubgraph;
}) {
  const extra = (node.extra ?? {}) as Record<string, unknown>;
  switch (node.label) {
    case "ResearchGoal": return <ResearchGoalDetail extra={extra} />;
    case "SubTask": return <SubTaskDetail extra={extra} />;
    case "Paper": return <PaperDetail extra={extra} />;
    case "Evidence": return <EvidenceDetail extra={extra} />;
    case "Claim": return <ClaimDetail extra={extra} />;
    case "Code": return <CodeDetail node={node} client={client} sessionId={sessionId} subgraph={subgraph} />;
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

// --- SubTask ----------------------------------------------------------------

// Friendly display for known task_type values; unknown values pass through.
function taskTypeLabel(taskType: string, t: (key: "node.task_type.code_execution" | "node.task_type.literature_search") => string): string {
  if (taskType === "code_execution") return t("node.task_type.code_execution");
  if (taskType === "literature_search") return t("node.task_type.literature_search");
  return taskType;
}

function SubTaskDetail({ extra }: { extra: Record<string, unknown> }) {
  const { t } = useLocale();
  const status = typeof extra.status === "string" ? extra.status : undefined;
  const taskType = typeof extra.task_type === "string" ? extra.task_type : undefined;
  const taskTypeDisplay = taskType ? taskTypeLabel(taskType, t) : undefined;
  return <div className="node-detail-body">
    {status ? <span className={`node-status-badge node-status-${status}`}>{status}</span> : null}
    <dl className="node-detail-fields">
      {taskTypeDisplay ? <Field label={t("node.field.task_type")} value={taskTypeDisplay} /> : null}
      {typeof extra.source === "string" && extra.source ? <Field label={t("node.field.source")} value={extra.source} /> : null}
      {typeof extra.tool_type === "string" && extra.tool_type ? <Field label={t("node.field.tool_type")} value={extra.tool_type} /> : null}
      {extra.finished_at ? <Field label={t("node.field.finished_at")}><TimeField value={extra.finished_at} /></Field> : null}
      {extra.created_at ? <Field label={t("node.field.created_at")}><TimeField value={extra.created_at} /></Field> : null}
      {typeof extra.result_count === "number" ? <Field label={t("node.field.result_count")} value={extra.result_count} /> : null}
    </dl>
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
          if (!match) { if (active) setNote("The produced artifact is no longer in the workspace."); return; }
          const versions = await client.listArtifactVersions(sessionId, match.id);
          const versionId = versions.at(-1)?.id;
          if (!versionId) { if (active) setNote("The produced artifact is no longer in the workspace."); return; }
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
          if (!codeEntry && !logEntry) setNote("No script or log was recorded for this run.");
          return;
        }
        // Path B — no produced artifact; recover straight from the ExecutionRun
        // (code_id = executionId) via CAS. A run that genuinely has no script or
        // no output is the only case that lands a note here.
        const runs = await client.listExecutionRuns(sessionId);
        if (!active) return;
        const run = runs.find((candidate) => candidate.id === runId);
        if (!run) { if (active) setNote("No script or log was recorded for this run."); return; }
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
        if (!codeText && !stdoutText && !stderrText) setNote("No script or log was recorded for this run.");
      } catch (error) {
        if (active) setNote(error instanceof Error ? error.message : "Could not load this run's script or logs.");
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
  const nonEmpty = Object.entries(extra).filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!nonEmpty.length) return <p className="artifact-empty compact">No properties recorded for this node.</p>;
  return <dl className="memory-graph-detail-props">
    {nonEmpty.map(([key, value]) => <div className="memory-graph-detail-prop" key={key}>
      <dt>{key}</dt>
      <dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
    </div>)}
  </dl>;
}

/**
 * Left-column fallback for nodes that are not artifacts (SubTask, Code, Paper,
 * …): shows the node's header, its outgoing relationships, and delegates the
 * property surface to the per-label detail component (which recovers script /
 * logs for Code nodes, formats times/links, and truncates long text).
 */
export function MemoryGraphNodeDetail({
  client,
  node,
  onSelectNode,
  resolveState,
  sessionId,
  subgraph,
}: {
  client: ApiClient;
  node?: MemoryGraphNode;
  /** Follow a relationship to its target node. Omit to render the chips as plain text. */
  onSelectNode?: (nodeId: string) => void;
  resolveState: ResolveState;
  sessionId: string;
  subgraph: MemorySubgraph;
}) {
  const { t } = useLocale();
  if (!node) {
    return <div className="memory-product memory-product-idle">
      <p className="artifact-empty compact">{t("node.idle.prompt")}</p>
    </div>;
  }

  // Outgoing edges grouped by relationship. Listing them all under "produces"
  // misreports the graph: a SubTask *produces* its Code and runs *next* before
  // the following SubTask, and those are different claims.
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
      <NodeProperties node={node} client={client} sessionId={sessionId} subgraph={subgraph} />
    </div>
  </div>;
}
