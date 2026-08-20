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
 * Memory-graph client + sink for the API process.
 *
 * The Node control API is the only client of the Python memory-graph service
 * (loopback :17674, Bearer ``SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN``).
 * ``MemoryGraphSink.observeExecution`` never throws into the agent loop — a
 * disabled or unreachable graph must never block chat or execution. When the
 * System Settings toggle is off (``MemoryGraphSettings.enabled === false``)
 * or the sidecar is unreachable, every call is a no-op and reads return an
 * empty subgraph.
 */

import { Buffer } from "node:buffer";

import type {
  ComposerReferenceKind,
  DeclareChipEntry,
  DeclareClaimInput,
  DeclareClaimResult,
  DeclareError,
  DeclareEvidenceInput,
  DeclareResult,
  MemoryGraphByEdgeResult,
  MemoryGraphChainResult,
  MemoryGraphEdge,
  MemoryGraphEdgeType,
  MemoryGraphHit,
  MemoryGraphMatchResponse,
  MemoryGraphNode,
  MemoryGraphNodeLabel,
  MemoryGraphTraceNode,
  MemoryGraphTraceResult,
  MemorySubgraph,
} from "@science-agent/schema";

export type {
  DeclareChipEntry,
  DeclareClaimInput,
  DeclareClaimOk,
  DeclareClaimResult,
  DeclareError,
  DeclareEvidenceInput,
  DeclareResult,
} from "@science-agent/schema";

import { mgLog } from "./memory-graph-log.js";

/** Aggregated provenance addressing info for one Artifact version, returned
 * by the sidecar's ``GET /query/artifact-provenance``. Every field is a hash or
 * a routing key — never a content blob (graph = directory, CAS/store =
 * warehouse). The handler uses these to fetch the bodies from CAS/store.
 *
 * ``reason`` is set (and every other field absent) when the sidecar degraded
 * (``memory_graph_unreachable``) or the version node is not in the graph
 * (``node_not_found``); the handler falls back to the store path in both cases. */
export interface ArtifactProvenanceGraphResult {
  reason?: string;
  artifactId?: string;
  version?: number;
  logicalName?: string | null;
  mediaType?: string | null;
  /** CAS hash of the produced artifact body (diff/download addressing). */
  contentHash?: string | null;
  /** Review routing key — version.turnId. */
  turnId?: string | null;
  /** Code node hashes for the code/executionLog/environments blocks. */
  codeHash?: string | null;
  stdoutHash?: string | null;
  stderrHash?: string | null;
  envHash?: string | null;
  exitCode?: number | null;
  status?: string | null;
  finishedAt?: string | null;
  startedAt?: string | null;
  /** executionId (= Code.code_id); the handler fetches the full ExecutionRun
   * from the store for language/tool if needed. */
  codeId?: string | null;
  language?: string | null;
  tool?: string | null;
  /** Messages routing key — the producing SubTask's turn_id (store filters
   * manifests by turnId, the same key review uses). */
  messagesTurnId?: string | null;
  /** Derived-from inputs (input-edge endpoints); empty when the run read no
   * inputs or the input edges are absent — the handler falls back to the
   * store's inputArtifactVersionIds in that case. */
  dependencies?: Array<{ artifactId: string; version: number; logicalName: string | null; mediaType: string | null; path: string | null }>;
}

export interface MemoryGraphProducedArtifact {
  artifactId: string;
  path: string;
  version: number;
  mediaType: string;
  /** Mirrors SessionStore's ScientificArtifact.logicalName onto the graph node
   * (UI renders "squares.csv" from this). Carries the same value as ``path``
   * today (Node-side logicalName == logicalPath). */
  logicalName: string;
  projectId: string;
  /** The Artifact versions this Code run read as inputs — composite-key
   * pairs ``{artifactId, version}``, NOT SessionStore UUIDs. Drives the
   * ``input`` edge (Artifact → Code) in ``upsert_execution``. Absent when the
   * run read no other artifacts. The field name intentionally differs from
   * the schema's UUID-semantic ``inputArtifactVersionIds`` to avoid one name
   * carrying two meanings. See docs/memory-graph-derived-from-impl.md §3.3. */
  inputArtifactVersions?: Array<{ artifactId: string; version: number }>;
  /** The turn this version was produced in — review routing key mirrored onto
   * the version node. */
  turnId?: string;
  /** The produced artifact's CAS content hash, mirrored onto the version node
   * (graph = directory, CAS = warehouse). */
  contentHash?: string;
}

export interface ObserveExecutionPayload {
  executionId: string;
  sessionId: string;
  turnId: string;
  tool: string;
  language: string | null;
  codeHash: string;
  exitCode: number | null;
  status: string;
  startedAt: string;
  finishedAt: string;
  taskType: string;
  producedArtifacts: MemoryGraphProducedArtifact[];
  /** Provenance addressing info mirrored onto the Code node: CAS hashes for the
   * stdout/stderr/env blocks. null when the Node side has none (shell runs have
   * no env snapshot). Graph stores only hashes, never the blobs. */
  stdoutHash?: string | null;
  stderrHash?: string | null;
  envHash?: string | null;
}

// MemorySubgraph / MemoryGraphNode / MemoryGraphEdge live in @science-agent/schema
// (packages/schema/src/index.ts) and are shared with the frontend so the two
// sides cannot silently drift when new node types or fields are added.

export interface MemoryGraphMcpRecord {
  url: string;
  title?: string;
  identifier?: string;
  identifierType?: string;
  year?: string;
  authors?: string[];
  abstract?: string;
  source?: string;
}

export interface ObserveMcpInvocationPayload {
  invocationId: string;
  sessionId: string;
  turnId: string;
  source: string;
  toolType: string;
  retrievedAt: string;
  records: MemoryGraphMcpRecord[];
}

// Passive ResearchGoal fallback + SessionPlan → SubTask DAG mirror.
// Domain is inferred from message/plan keywords, not read from any
// project, so it travels with the payload instead of being looked up.

export interface ObserveSessionFirstMessagePayload {
  sessionId: string;
  /** Deterministic ``goal:session:<sessionId>`` → re-sends stay one goal. */
  goalId: string;
  coreObjective: string;
  /** inferDomain(message); empty string when no keyword hits. */
  domain?: string;
  topicScope: string[];
  createdAt: string;
}

export interface PlanStepMirror {
  id: string;
  description: string;
}

export interface ObserveSessionPlanPayload {
  sessionId: string;
  goalId: string;
  planId: string;
  /** plan.scope — overwrites the first-message goal fallback. */
  scope: string;
  /** inferDomain(plan.scope) — re-inferred on plan correction. */
  domain: string;
  steps: PlanStepMirror[];
}

/**
 * Lightweight keyword heuristic for a ResearchGoal's domain.
 *
 * Pure passive fallback — precision is not the goal; "the graph has a goal
 * with a plausible domain" is. The LLM's explicit plan.scope corrects it
 * later. Biology keywords take priority over DataAnalysis so a
 * data-analysis task that happens to mention a gene lands in Biology.
 *
 * Bilingual: ScienceDiscovery users write in Chinese, so each domain pairs English
 * keywords with their Chinese equivalents. Common protein/gene symbols
 * (TP53/KRAS/EGFR/BRCA…) are treated as Biology even mid-Chinese-sentence,
 * where the English ``\b`` word boundary does not fire (CJK has no
 * whitespace) — so symbol patterns drop the boundary for that case.
 * Returns "" when no keyword hits (the goal still gets created, domain-less).
 */
const DOMAIN_KEYWORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(mutation|gene|protein|pdb|structure|sequence|align|tp\d+|kras|egfr|brca\d?|alk|myc|ras|onco|allele|变异|突变|基因|蛋白|序列|表达)/i, "Biology"],
  [/(cell|tissue|culture|stain|flow\s*citometry|细胞|组织|培养|染色|流式)/i, "CellBiology"],
  [/(clinical|patient|cohort|survival|diagnosis|prognos|临床|患者|队列|生存率|诊断|预后)/i, "Clinical"],
  [/(mol\b|smiles|docking|binding|ligand|分子|对接|配体|结合)/i, "Chemistry"],
  [/(csv|histogram|regression|correlation|sales|直方图|回归|相关)/i, "DataAnalysis"], // last
];

export function inferDomain(text: string): string {
  for (const [pattern, domain] of DOMAIN_KEYWORDS) {
    if (pattern.test(text)) return domain;
  }
  return "";
}

export class MemoryGraphClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(options: { url: string; token?: string }) {
    this.baseUrl = options.url.replace(/\/$/, "");
    this.token = options.token;
  }

  async health(): Promise<string> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      if (!response.ok) {
        mgLog.warn("health check failed: memory-graph returned HTTP %s", response.status);
        return "degraded";
      }
      const body = (await response.json()) as { status?: string };
      const status = body.status ?? "degraded";
      mgLog.info("health check: memory-graph status is %s", status);
      return status;
    } catch (error) {
      mgLog.warn("health check error: %s", error instanceof Error ? error.message : String(error));
      return "degraded";
    }
  }

  /** Push the Neo4j credential (and optional HTTP/user override) to the sidecar.
   *  ``password`` null clears the stored credential; a string sets/replaces it.
   *  HTTP/user are sent only when provided so the sidecar keeps its current
   *  values otherwise (the store may push just a password update). */
  async pushNeo4jPassword(password: string | null, options?: { httpUri?: string; user?: string }): Promise<void> {
    mgLog.info("pushing Neo4j credential to memory-graph (http=%s, user=%s, password=%s)",
      options?.httpUri ? "changed" : "same", options?.user ? "changed" : "same",
      password === null ? "cleared" : password ? "set" : "unchanged");
    try {
      const body: Record<string, unknown> = { password };
      if (options?.httpUri !== undefined) body.http_uri = options.httpUri;
      if (options?.user !== undefined) body.user = options.user;
      await this.post("/internal/neo4j-password", body);
      mgLog.info("password push complete");
    } catch (error) {
      mgLog.warn("password push failed: %s", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async observeExecution(payload: ObserveExecutionPayload): Promise<void> {
    mgLog.info("observeExecution in: execution=%s session=%s tool=%s produced=%d file(s)",
      payload.executionId, payload.sessionId, payload.tool, payload.producedArtifacts.length);
    try {
      await this.post("/observe/execution", {
        execution_id: payload.executionId,
        session_id: payload.sessionId,
        turn_id: payload.turnId,
        tool: payload.tool,
        language: payload.language,
        code_hash: payload.codeHash,
        exit_code: payload.exitCode,
        status: payload.status,
        started_at: payload.startedAt,
        finished_at: payload.finishedAt,
        task_type: payload.taskType,
        produced_artifacts: payload.producedArtifacts.map((artifact) => ({
          artifact_id: artifact.artifactId,
          path: artifact.path,
          version: artifact.version,
          media_type: artifact.mediaType,
          logical_name: artifact.logicalName,
          project_id: artifact.projectId,
          input_artifact_versions: (artifact.inputArtifactVersions ?? []).map((ref) => ({
            artifact_id: ref.artifactId,
            version: ref.version,
          })),
          turn_id: artifact.turnId,
          content_hash: artifact.contentHash,
        })),
        stdout_hash: payload.stdoutHash ?? null,
        stderr_hash: payload.stderrHash ?? null,
        env_hash: payload.envHash ?? null,
      });
      mgLog.info("observeExecution done: execution=%s delivered", payload.executionId);
    } catch (error) {
      mgLog.warn("observeExecution failed: execution=%s, error %s",
        payload.executionId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async observeMcpInvocation(payload: ObserveMcpInvocationPayload): Promise<void> {
    const papersWithUrl = payload.records.filter((record) => Boolean(record.url)).length;
    mgLog.info("observeMcpInvocation in: invocation=%s session=%s source=%s records=%d (%d with url)",
      payload.invocationId, payload.sessionId, payload.source, payload.records.length, papersWithUrl);
    try {
      await this.post("/observe/mcp-search", {
        invocation_id: payload.invocationId,
        session_id: payload.sessionId,
        turn_id: payload.turnId,
        source: payload.source,
        tool_type: payload.toolType,
        retrieved_at: payload.retrievedAt,
        records: payload.records.map((record) => ({
          url: record.url,
          title: record.title,
          identifier: record.identifier,
          identifier_type: record.identifierType,
          year: record.year,
          authors: record.authors,
          abstract: record.abstract,
          source: record.source,
        })),
      });
      mgLog.info("observeMcpInvocation done: invocation=%s delivered (%d papers)",
        payload.invocationId, papersWithUrl);
    } catch (error) {
      mgLog.warn("observeMcpInvocation failed: invocation=%s, error %s",
        payload.invocationId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async observeSessionFirstMessage(payload: ObserveSessionFirstMessagePayload): Promise<void> {
    mgLog.info("observeSessionFirstMessage in: session=%s goal=%s domain=%s",
      payload.sessionId, payload.goalId, payload.domain || "<empty>");
    try {
      await this.post("/observe/session-first-message", {
        session_id: payload.sessionId,
        goal_id: payload.goalId,
        core_objective: payload.coreObjective,
        domain: payload.domain ?? null,
        topic_scope: payload.topicScope,
        created_at: payload.createdAt,
      });
      mgLog.info("observeSessionFirstMessage done: session=%s goal=%s",
        payload.sessionId, payload.goalId);
    } catch (error) {
      mgLog.warn("observeSessionFirstMessage failed: session=%s goal=%s, error %s",
        payload.sessionId, payload.goalId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async observeSessionPlan(payload: ObserveSessionPlanPayload): Promise<void> {
    mgLog.info("observeSessionPlan in: session=%s plan=%s goal=%s steps=%d",
      payload.sessionId, payload.planId, payload.goalId, payload.steps.length);
    try {
      await this.post("/observe/session-plan", {
        session_id: payload.sessionId,
        goal_id: payload.goalId,
        plan_id: payload.planId,
        scope: payload.scope,
        domain: payload.domain || null,
        steps: payload.steps.map((step) => ({ id: step.id, description: step.description })),
      });
      mgLog.info("observeSessionPlan done: session=%s plan=%s (goal corrected from plan.scope)",
        payload.sessionId, payload.planId);
    } catch (error) {
      mgLog.warn("observeSessionPlan failed: session=%s plan=%s, error %s",
        payload.sessionId, payload.planId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async getSubgraph(sessionId: string): Promise<MemorySubgraph> {
    const url = `${this.baseUrl}/subgraph?session_id=${encodeURIComponent(sessionId)}`;
    let response: Response;
    try {
      response = await fetch(url, { headers: this.initHeaders() });
    } catch (error) {
      mgLog.warn("getSubgraph error: cannot reach memory-graph service (session=%s): %s",
        sessionId, error instanceof Error ? error.message : String(error));
      return { nodes: [], edges: [], total: 0, truncated: false, reason: "memory_graph_unreachable" };
    }
    if (!response.ok) {
      mgLog.warn("getSubgraph not ok: memory-graph returned HTTP %s (session=%s)", response.status, sessionId);
      return { nodes: [], edges: [], total: 0, truncated: false, reason: "memory_graph_unreachable" };
    }
    const body = (await response.json()) as Record<string, unknown>;
    const result: MemorySubgraph = {
      nodes: (body.nodes as MemoryGraphNode[]) ?? [],
      edges: (body.edges as MemoryGraphEdge[]) ?? [],
      total: (body.total as number) ?? 0,
      truncated: Boolean(body.truncated),
      reason: body.reason as string | undefined,
    };
    if (result.reason) {
      mgLog.info("getSubgraph out: empty for session=%s (reason=%s)", sessionId, result.reason);
    } else {
      mgLog.info("getSubgraph out: session=%s returned %d node(s) and %d edge(s)",
        sessionId, result.nodes.length, result.edges.length);
    }
    return result;
  }

  /** Aggregate one Artifact version's provenance addressing info + derived-from
   * dependencies via the ``input``/``produces`` 2-hop (the ``input`` edge
   * written by ``upsert_execution``). Returns the five fields' hashes/routing
   * keys + dependencies; ``reason`` is set (and other fields absent) when the
   * graph is off/unreachable or the version node is absent (produced while the
   * graph was off), so the handler can fall back to the store/CAS path. Mirrors
   * ``getSubgraph``'s defensive GET contract: never throws into the agent loop. */
  async getArtifactProvenance(
    artifactId: string,
    version: number,
    sessionId?: string,
  ): Promise<ArtifactProvenanceGraphResult | null> {
    const params = new URLSearchParams({ artifact_id: artifactId, version: String(version) });
    if (sessionId) params.set("session_id", sessionId);
    const url = `${this.baseUrl}/query/artifact-provenance?${params}`;
    let response: Response;
    try {
      response = await fetch(url, { headers: this.initHeaders() });
    } catch (error) {
      mgLog.warn("getArtifactProvenance error: cannot reach memory-graph service (artifact=%s v%s): %s",
        artifactId, version, error instanceof Error ? error.message : String(error));
      return null;
    }
    if (response.status === 404) {
      mgLog.info("getArtifactProvenance out: artifact=%s v%s not found", artifactId, version);
      return { reason: "node_not_found" };
    }
    if (!response.ok) {
      mgLog.warn("getArtifactProvenance not ok: memory-graph returned HTTP %s (artifact=%s v%s)",
        response.status, artifactId, version);
      return null;
    }
    const result = (await response.json()) as Record<string, unknown>;
    if (result.reason) {
      mgLog.info("getArtifactProvenance out: empty for artifact=%s v%s (reason=%s)",
        artifactId, version, result.reason);
      return { reason: result.reason as string };
    }
    return this.toArtifactProvenance(result);
  }

  // --- Cross-session read endpoints -----------------------------------------
  //
  // All five mirror `getSubgraph`'s defensive contract: a disabled or
  // unreachable sidecar never throws into the agent loop or UI — the call
  // resolves to an empty result carrying a `reason`. The Node API server's
  // reverse-proxy layer also short-circuits when the client itself is null
  // (feature off), see server.ts.

  async queryMatch(query: string, sessionId?: string): Promise<MemoryGraphMatchResponse> {
    const body = await this.postJson("/query/match", { query, session_id: sessionId ?? null });
    return this.toMatchResponse(body);
  }

  async byNodeType(nodeTypes: MemoryGraphNodeLabel[], sessionId?: string): Promise<MemoryGraphMatchResponse> {
    const body = await this.postJson("/query/by-node-type", { node_types: nodeTypes, session_id: sessionId ?? null });
    return this.toMatchResponse(body);
  }

  async byEdgeType(edgeTypes: MemoryGraphEdgeType[], sessionId?: string): Promise<MemoryGraphByEdgeResult> {
    const body = await this.postJson("/query/by-edge-type", { edge_types: edgeTypes, session_id: sessionId ?? null });
    const result = body as Record<string, unknown>;
    const rawNodes = (result.nodes as Array<Record<string, unknown>>) ?? [];
    return {
      edges: (result.edges as MemoryGraphByEdgeResult["edges"]) ?? [],
      nodes: rawNodes.map((n) => this.toHit(n)),
      total: (result.total as number) ?? 0,
      truncated: Boolean(result.truncated),
      reason: result.reason as string | undefined,
    };
  }

  async getChain(
    nodeId: string,
    sessionId?: string,
    version?: number,
    chainKind?: "full" | "task" | "artifact",
  ): Promise<MemoryGraphChainResult> {
    const body = await this.postJson("/query/chain", {
      node_id: nodeId,
      session_id: sessionId ?? null,
      // Pins an Artifact source to a specific version (composite key); absent
      // → sidecar uses the latest version. Ignored for non-Artifact labels.
      ...(version != null ? { version } : {}),
      // Which chain to walk: full (default, joint subgraph), task (pure
      // next+produces spine), or artifact (directed walk from the report
      // anchor, pruned to the path reaching the selected node). The frontend
      // picks one per button.
      chain_kind: chainKind ?? "full",
    });
    const result = body as Record<string, unknown>;
    const rawNodes = (result.nodes as Array<Record<string, unknown>>) ?? [];
    // Chain nodes carry `extra` + `created_at` like hits; reuse the hit shaping.
    const nodes = rawNodes.map((n) => this.toHit(n)) as unknown as MemoryGraphNode[];
    return {
      nodes,
      edges: (result.edges as MemoryGraphEdge[]) ?? [],
      total: (result.total as number) ?? 0,
      truncated: Boolean(result.truncated),
      reason: result.reason as string | undefined,
    };
  }

  /**
   * Trace the provenance chain from a node and return whether it is intact
   * (``broken``/``truncated``/``reason``). Mirrors ``getChain``'s defensive
   * contract: an unreachable sidecar never throws into the reviewer/agent
   * loop — it resolves to ``{broken:true, reason:"memory_graph_unreachable"}``
   * so the reviewer can mark the artifact for manual verification rather than
   * erroring. The sidecar's snake_case body (``via_edge``/``is_terminal``/
   * ``start_node``) is mapped to camelCase here.
   */
  async traceProvenance(
    input: {
      nodeId: string;
      targetLabel?: string;
      maxHops?: number;
    },
    sessionId?: string,
  ): Promise<MemoryGraphTraceResult> {
    const body = await this.postJson("/trace/provenance", {
      node_id: input.nodeId,
      target_label: input.targetLabel ?? null,
      max_hops: input.maxHops ?? 8,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    return this.toTraceResult(body);
  }

  /** Shape the sidecar's trace response (snake_case → camelCase), and
   * translate ``postJson``'s degraded-empty shell (``{reason, no chain}``,
   * produced on a network failure) into ``broken:true`` so a down graph
   * surfaces as "needs manual verification" rather than an intact chain. */
  private toTraceResult(body: unknown): MemoryGraphTraceResult {
    const r = (body ?? {}) as Record<string, unknown>;
    // postJson returns {hits:[], total:0, truncated:false, reason} on failure
    // — no chain/start_node. Collapse that into the broken-trace shape.
    if (r.chain === undefined) {
      return { startNode: null, chain: [], broken: true, truncated: false, reason: r.reason as string | undefined };
    }
    const rawChain = (r.chain as Array<Record<string, unknown>>) ?? [];
    return {
      startNode: r.start_node ? this.toTraceNode(r.start_node as Record<string, unknown>) : null,
      chain: rawChain.map((hop) => ({
        hop: hop.hop as number,
        node: this.toTraceNode(hop.node as Record<string, unknown>),
        viaEdge: hop.via_edge as string,
        ...(hop.is_terminal ? { isTerminal: true } : {}),
      })),
      broken: Boolean(r.broken),
      truncated: Boolean(r.truncated),
      reason: r.reason as string | undefined,
    };
  }

  private toTraceNode(raw: Record<string, unknown>): MemoryGraphTraceNode {
    return {
      label: raw.label as MemoryGraphNodeLabel,
      id: raw.id as string,
      excerpt: (raw.excerpt as string) ?? "",
      // content_hash (Artifact: content_hash; Code: code_hash) → contentHash.
      // Omitted by the sidecar for labels with no body hash.
      ...(typeof raw.content_hash === "string" && raw.content_hash
        ? { contentHash: raw.content_hash }
        : {}),
    };
  }

  /** Shape the sidecar's aggregate row into the typed result. Each field is a
   * hash or routing key — never content. */
  private toArtifactProvenance(raw: Record<string, unknown>): ArtifactProvenanceGraphResult {
    const dependencies = (raw.dependencies as Array<Record<string, unknown>> | undefined) ?? [];
    return {
      artifactId: raw.artifact_id as string,
      version: raw.version as number,
      logicalName: (raw.logical_name as string | null) ?? null,
      mediaType: (raw.media_type as string | null) ?? null,
      contentHash: (raw.content_hash as string | null) ?? null,
      turnId: (raw.turn_id as string | null) ?? null,
      codeHash: (raw.code_hash as string | null) ?? null,
      stdoutHash: (raw.stdout_hash as string | null) ?? null,
      stderrHash: (raw.stderr_hash as string | null) ?? null,
      envHash: (raw.env_hash as string | null) ?? null,
      exitCode: raw.exit_code as number | null,
      status: (raw.status as string | null) ?? null,
      finishedAt: (raw.finished_at as string | null) ?? null,
      startedAt: (raw.started_at as string | null) ?? null,
      codeId: (raw.code_id as string | null) ?? null,
      language: (raw.language as string | null) ?? null,
      tool: (raw.tool as string | null) ?? null,
      messagesTurnId: (raw.messages_turn_id as string | null) ?? null,
      dependencies: dependencies.map((dep) => ({
        artifactId: dep.artifact_id as string,
        version: dep.version as number,
        logicalName: (dep.logical_name as string | null) ?? null,
        mediaType: (dep.media_type as string | null) ?? null,
        path: (dep.path as string | null) ?? null,
      })),
    };
  }

  // --- declare_* (LLM tools; surface business errors, do NOT degrade) --------
  //
  // The read endpoints above degrade to an empty result when the sidecar is
  // unreachable (the agent loop must not break). These declare methods do the
  // opposite: they return a structured {status:"error", code} so the LLM can
  // decide what to do — the sidecar's 422 body carries {code, message}, and a
  // network failure becomes code:"internal_error" / "memory_graph_disabled".

  async declareEvidence(input: DeclareEvidenceInput, sessionId: string): Promise<DeclareResult> {
    try {
      const body = await this.postJsonWithBody("/persist/evidence", {
        content: input.content,
        source_paper_link: input.sourcePaperLink,
        locator: input.locator,
        evidence_type: input.evidenceType,
        confidence: input.confidence,
        strength: input.strength,
        session_id: sessionId,
      }) as Record<string, unknown>;
      if (body.status === "degraded" || body.status === "disabled") {
        return { status: "error", code: "memory_graph_disabled", message: "memory graph not available" };
      }
      return { status: "ok", evidenceId: body.evidence_id as string | undefined };
    } catch (error) {
      return this.toDeclareError(error, "/persist/evidence");
    }
  }

  async declareClaim(input: DeclareClaimInput, sessionId: string): Promise<DeclareClaimResult> {
    try {
      const body = await this.postJsonWithBody("/persist/claim", {
        content: input.content,
        claim_type: input.claimType,
        confidence: input.confidence,
        locator: input.locator,
        cites_evidence_aliases: input.citesEvidenceAliases,
        cites_artifact_aliases: input.citesArtifactAliases,
        // Pins each cited artifact alias to its exact version (composite key).
        // The Node-side declare callback fills this from the store; the LLM
        // never sees versions. Absent → sidecar falls back to latest.
        ...(input.citesArtifactVersions ? { cites_artifact_versions: input.citesArtifactVersions } : {}),
        ...(input.artifactId ? { artifact_id: input.artifactId } : {}),
        // The report version pins stated_in to the report's exact version; may
        // be absent at declare time (report not landed), re-linked by
        // persist/stated_in.
        ...(input.artifactId && input.artifactVersion != null ? { artifact_version: input.artifactVersion } : {}),
        session_id: sessionId,
      }) as Record<string, unknown>;
      if (body.status === "degraded" || body.status === "disabled") {
        return { status: "error", code: "memory_graph_disabled", message: "memory graph not available" };
      }
      const chipMap = this.toChipMap(body.chip_map);
      return { status: "ok", claimId: body.claim_id as string, chipMap };
    } catch (error) {
      return this.toDeclareError(error, "/persist/claim") as DeclareClaimResult;
    }
  }

  /** Link the Claims declared in a turn to the report Artifact version via
   * ``stated_in`` edges (Claim → Artifact). Called by the provenance recorder
   * after a report version lands; never throws into the report write path
   * (the sink wraps this). ``artifactVersion`` pins the stated_in edge to the
   * report's exact version (composite key). */
  async linkClaimsToReport(artifactId: string, artifactVersion: number, claimIds: string[], sessionId: string): Promise<void> {
    await this.postJsonWithBody("/persist/stated_in", {
      artifact_id: artifactId,
      artifact_version: artifactVersion,
      claim_ids: claimIds,
      session_id: sessionId,
    });
  }

  /** Post helper that preserves the 422 {code, message} body for declare tools.
   *
   * The read path's `postJson` swallows non-2xx into a degraded-empty result;
   * declare tools need the business code, so this throws a `DeclareError`
   * shaped object the caller turns into its return value. */
  private async postJsonWithBody(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.initHeaders(true),
        body: JSON.stringify(body),
      });
    } catch (error) {
      mgLog.warn("postJsonWithBody %s error: cannot reach memory-graph service: %s",
        path, error instanceof Error ? error.message : String(error));
      throw { status: "error", code: "memory_graph_disabled", message: "memory graph not available" } as DeclareError;
    }
    const respBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      // FastAPI HTTPException detail is {code, message, instruction?} from the
      // sidecar's _error. instruction is an actionable next step for the LLM.
      const detail = (respBody.detail ?? respBody) as Record<string, unknown>;
      const code = (detail.code as string) ?? "internal_error";
      const message = (detail.message as string) ?? `memory-graph ${path} failed: ${response.status}`;
      const instruction = (detail.instruction as string) ?? undefined;
      mgLog.warn("postJsonWithBody %s not ok: HTTP %s code=%s", path, response.status, code);
      throw { status: "error", code, message, ...(instruction ? { instruction } : {}) } as DeclareError;
    }
    return respBody;
  }

  private toDeclareError(error: unknown, path: string): DeclareError {
    if (error && typeof error === "object" && "status" in error && (error as DeclareError).status === "error") {
      return error as DeclareError;
    }
    mgLog.warn("declare %s unexpected error: %s", path, error instanceof Error ? error.message : String(error));
    return { status: "error", code: "internal_error", message: String(error) };
  }

  /** Shape the sidecar's chip_map {alias: {kind,id,label}} into the typed form. */
  private toChipMap(raw: unknown): Record<string, DeclareChipEntry> {
    const map = (raw ?? {}) as Record<string, Record<string, unknown>>;
    const out: Record<string, DeclareChipEntry> = {};
    for (const [alias, entry] of Object.entries(map)) {
      if (!entry || typeof entry.id !== "string" || typeof entry.kind !== "string") continue;
      const chip: DeclareChipEntry = { id: entry.id, kind: entry.kind as ComposerReferenceKind, label: (entry.label as string) ?? entry.id };
      // artifact chips carry the cited version so the frontend opens that
      // version instead of the latest (which would drift on regeneration).
      if (entry.kind === "artifact" && typeof entry.version === "number") {
        chip.version = entry.version;
      }
      out[alias] = chip;
    }
    return out;
  }

  private toMatchResponse(body: unknown): MemoryGraphMatchResponse {
    const result = body as Record<string, unknown>;
    const rawHits = (result.hits as Array<Record<string, unknown>>) ?? [];
    return {
      hits: rawHits.map((h) => this.toHit(h)),
      total: (result.total as number) ?? 0,
      truncated: Boolean(result.truncated),
      reason: result.reason as string | undefined,
    };
  }

  private toHit(raw: Record<string, unknown>): MemoryGraphHit {
    return {
      label: raw.label as MemoryGraphNodeLabel,
      id: raw.id as string,
      sessionId: raw.session_id as string | undefined,
      sessionTitle: raw.session_title as string | undefined,
      excerpt: (raw.excerpt as string) ?? "",
      extra: (raw.extra as Record<string, unknown>) ?? {},
      createdAt: (raw.created_at as string) ?? "",
    };
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.initHeaders(true),
        body: JSON.stringify(body),
      });
    } catch (error) {
      mgLog.warn("postJson %s error: cannot reach memory-graph service: %s",
        path, error instanceof Error ? error.message : String(error));
      return { hits: [], total: 0, truncated: false, reason: "memory_graph_unreachable" };
    }
    if (!response.ok) {
      mgLog.warn("postJson %s not ok: memory-graph returned HTTP %s", path, response.status);
      return { hits: [], total: 0, truncated: false, reason: "memory_graph_unreachable" };
    }
    return response.json();
  }

  private async post(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.initHeaders(true),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      mgLog.warn("post %s not ok: memory-graph returned HTTP %s", path, response.status);
      throw new Error(`memory-graph ${path} failed: ${response.status}`);
    }
  }

  private initHeaders(json = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (json) headers["content-type"] = "application/json";
    return headers;
  }
}

export class MemoryGraphSink {
  private readonly client: MemoryGraphClient | null;
  private readonly isEnabled: () => boolean;

  constructor(client: MemoryGraphClient | null, enabled: () => boolean) {
    this.client = client;
    this.isEnabled = enabled;
  }

  /** Live toggle state, read from the store on each call so flipping the
   *  System Settings switch takes effect on the next mirror without a
   *  restart. Preserved as a getter so existing `sink.enabled` readers
   *  (e.g. run-metadata population) keep working and stay live. */
  get enabled(): boolean {
    return this.isEnabled();
  }

  /** Never throws into the caller. Errors are swallowed and logged. */
  observeExecution(payload: ObserveExecutionPayload): void {
    if (!this.isEnabled() || !this.client) {
      mgLog.debug("mirror skipped: memory graph not enabled (execution=%s)", payload.executionId);
      return;
    }
    mgLog.info("execution finished, mirroring to memory graph: execution=%s session=%s",
      payload.executionId, payload.sessionId);
    void this.client
      .observeExecution(payload)
      .then(() => undefined)
      .catch((error: unknown) => {
        mgLog.warn("mirror failed: execution=%s session=%s, error %s",
          payload.executionId, payload.sessionId,
          error instanceof Error ? error.message : String(error));
      });
  }

  /** Never throws into the caller. Errors are swallowed and logged. */
  observeMcpInvocation(payload: ObserveMcpInvocationPayload): void {
    if (!this.enabled || !this.client) {
      mgLog.debug("mirror skipped: memory graph not enabled (invocation=%s)", payload.invocationId);
      return;
    }
    mgLog.info("mcp search finished, mirroring to memory graph: invocation=%s session=%s",
      payload.invocationId, payload.sessionId);
    void this.client
      .observeMcpInvocation(payload)
      .then(() => undefined)
      .catch((error: unknown) => {
        mgLog.warn("mirror failed: invocation=%s session=%s, error %s",
          payload.invocationId, payload.sessionId,
          error instanceof Error ? error.message : String(error));
      });
  }

  /** Mirror a session's first user message into a ResearchGoal.
   * Never throws; a disabled/unreachable graph leaves chat unblocked. */
  observeSessionFirstMessage(payload: ObserveSessionFirstMessagePayload): void {
    if (!this.enabled || !this.client) {
      mgLog.debug("mirror skipped: memory graph not enabled (first-message session=%s)", payload.sessionId);
      return;
    }
    mgLog.info("first user message, mirroring ResearchGoal to memory graph: session=%s goal=%s",
      payload.sessionId, payload.goalId);
    void this.client
      .observeSessionFirstMessage(payload)
      .then(() => undefined)
      .catch((error: unknown) => {
        mgLog.warn("mirror failed: first-message session=%s goal=%s, error %s",
          payload.sessionId, payload.goalId,
          error instanceof Error ? error.message : String(error));
      });
  }

  /** Correct the ResearchGoal's scope/domain from a proposed SessionPlan's
   * scope. Steps are not mirrored into SubTask nodes (the framework doesn't
   * advance step status, so a skeleton would stay PENDING and clutter the
   * graph). Never throws; plan flow stays unblocked. */
  observeSessionPlan(payload: ObserveSessionPlanPayload): void {
    if (!this.enabled || !this.client) {
      mgLog.debug("mirror skipped: memory graph not enabled (plan=%s)", payload.planId);
      return;
    }
    mgLog.info("plan proposed, correcting ResearchGoal from plan.scope: session=%s plan=%s",
      payload.sessionId, payload.planId);
    void this.client
      .observeSessionPlan(payload)
      .then(() => undefined)
      .catch((error: unknown) => {
        mgLog.warn("mirror failed: plan=%s session=%s, error %s",
          payload.planId, payload.sessionId,
          error instanceof Error ? error.message : String(error));
      });
  }

  /** Link a just-landed report Artifact version to its turn's Claims via
   * ``stated_in`` edges (Claim → Artifact). Fire-and-forget; a degraded or
   * unreachable graph never blocks the report write. ``artifactVersion`` pins
   * stated_in to the report's exact version (composite key). */
  linkClaimsToReport(artifactId: string, artifactVersion: number, claimIds: string[], sessionId: string): void {
    if (!this.enabled || !this.client || !claimIds.length) {
      mgLog.debug("stated_in link skipped: memory graph not enabled or no claims (artifact=%s v%s)",
        artifactId, artifactVersion);
      return;
    }
    mgLog.info("report landed, linking stated_in to claims: artifact=%s v%s session=%s claims=%d",
      artifactId, artifactVersion, sessionId, claimIds.length);
    void this.client
      .linkClaimsToReport(artifactId, artifactVersion, claimIds, sessionId)
      .then(() => undefined)
      .catch((error: unknown) => {
        mgLog.warn("stated_in link failed: artifact=%s v%s session=%s, error %s",
          artifactId, artifactVersion, sessionId,
          error instanceof Error ? error.message : String(error));
      });
  }
}
