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

import type { Claim } from "./provenance.js";
import type { ComposerReferenceKind } from "./session.js";

export type MemoryGraphNodeLabel =
  | "ResearchGoal"
  | "SubTask"
  | "Paper"
  | "Evidence"
  | "Claim"
  | "Code"
  | "Artifact";

/**
 * Memory-graph edge types. `produces` is persisted by the MVP/SubTask mirror;
 * `extracted_from` / `cites` land with the declare tools; `states` links a
 * report Artifact to the Claim it asserts (Artifact → Claim). `supersedes`
 * links a new Artifact version to the one it replaces (Artifact → Artifact,
 * new → old), written whenever a version > 1 is produced. `input` links an
 * Artifact version that a Code run read to that Code (Artifact → Code),
 * symmetric to `produces` (Code → Artifact); together they form the
 * derived-from chain `input Artifact -[:input]-> Code -[:produces]-> output
 * Artifact`.
 */

export type MemoryGraphEdgeType =
  | "next"
  | "produces"
  | "extracted_from"
  | "cites"
  | "states"
  | "supersedes"
  | "input";

export interface MemoryGraphNode {
  label: MemoryGraphNodeLabel;
  id: string;
  sessionId?: string;
  /** Label-specific fields. Paper: { link, title, identifier, identifier_type, year?, authors?, abstract?, source, retrieved_at, retrieval_count, created_at }. SubTask: { task_id, session_id, status, task_type, source?, tool_type?, result_count?, finished_at, created_at, turn_id? }. Code/Artifact: as persisted by their upsert path. ResearchGoal: { goal_id, core_objective, domain, topic_scope?, created_at }. */
  extra?: Record<string, unknown>;
  createdAt?: string;
}

export interface MemoryGraphEdge {
  source: string;
  target: string;
  type: MemoryGraphEdgeType;
  /** Edge props forwarded from Neo4j: a temporal-chain fallback carries { inferred, basis:"finish_time", method:"temporal_chain" }; produces edges carry none. Used by the frontend to style temporal_chain links as a fallback. */
  extra?: Record<string, unknown>;
}

export interface MemorySubgraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  total: number;
  truncated: boolean;
  reason?: string;
}

/**
 * A search hit (substring match or by-node-type filter result). `excerpt` is a
 * label-specific snippet trimmed to <= 240 chars; `extra` carries the full
 * label-specific payload. Shared by `query/match`, `by-node-type`, and the
 * single-node detail endpoint.
 */

export interface MemoryGraphHit {
  label: MemoryGraphNodeLabel;
  id: string;
  sessionId?: string;
  sessionTitle?: string;
  excerpt: string;
  extra: Record<string, unknown>;
  createdAt: string;
}

/** Response for `POST /query/match` and `POST /query/by-node-type`. */

export interface MemoryGraphMatchResponse {
  hits: MemoryGraphHit[];
  total: number;
  truncated: boolean;
  reason?: string;
}

/**
 * Response for `POST /query/by-edge-type`: the matched edges plus the
 * de-duplicated endpoint nodes.
 */

export interface MemoryGraphByEdgeResult {
  edges: Array<{ type: MemoryGraphEdgeType; source: string; target: string; extra?: Record<string, unknown> }>;
  nodes: MemoryGraphHit[];
  total: number;
  truncated: boolean;
  reason?: string;
}

/**
 * Response for `POST /query/chain`: the upstream↔downstream subgraph around a
 * selected node, with the backend's preset rules deciding which edge/node
 * types to walk based on the source node's label.
 */

export interface MemoryGraphChainResult {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  total: number;
  truncated: boolean;
  reason?: string;
}

/**
 * `trace_provenance` 链上单跳的节点摘要(精简:label/id/excerpt + 该节点的
 * 文件 hash 寻址)。与 `MemoryGraphHit` 不同,trace 不带 session/extra/
 * created_at——reviewer 只需要"走到哪个节点 + 它的正文 hash"的线性链,
 * 不需要节点全量信息(那些从 GET /nodes/:label/:id 取)。
 *
 * `contentHash` 是该节点所代表内容的 CAS 正文 hash,reviewer 据此定位
 * 产物的真实正文(图谱只存 hash 寻址,正文留 CAS/store,见 !70 provenance
 * -fields)。按 label 取:Artifact→`content_hash`,Code→`code_hash`;其它
 * label 无正文 hash 该字段省略。
 */
export interface MemoryGraphTraceNode {
  label: MemoryGraphNodeLabel;
  id: string;
  excerpt: string;
  /** 该节点正文内容的 CAS hash(Artifact: content_hash; Code: code_hash)。
   * 无正文 hash 的 label(SubTask/ResearchGoal/…) 省略此字段。 */
  contentHash?: string;
}

/**
 * `trace_provenance` 响应(见 docs/05 §3.1)。给 reviewer specialist 消费的
 * 结构化上游证据链 + 真实性信号:
 * - `broken:false` 链完整,产物可追溯到 `target_label`(默认 ResearchGoal)
 * - `broken:true`  链中途断裂或图不可达,真实性存疑
 * - `truncated:true` 超 `max_hops` 截断(链未断但未到终点,需深查)
 * - `reason` 可读说明(到达终点 / 在哪断 / 为何截断)
 *
 * 注意:本类型**只输出 `broken`,不输出 verdict/decision**;后者由 reviewer
 * agent 内部从 `broken` 派生(见 08 文档 §8),不属于 trace 的响应字段。
 */
export interface MemoryGraphTraceResult {
  startNode: MemoryGraphTraceNode | null;
  chain: Array<{
    hop: number;
    node: MemoryGraphTraceNode;
    viaEdge: string;
    isTerminal?: boolean;
  }>;
  broken: boolean;
  truncated: boolean;
  reason?: string;
}

// --- declare_* tool contracts (Claim + Evidence writes) --------------------
//
// Shared between the Node memory-graph client (services/api) and the agent
// runtime tool options (packages/agent-runtime), so the two cannot drift on
// the LLM tool's input/output shape. Business errors surface as a structured
// {status:"error", code} so the LLM can react (swap a Paper, add a cite, give
// up); availability failures use code:"memory_graph_disabled".

export interface DeclareEvidenceInput {
  content: string;
  /** The source Paper's link (URL/DOI); resolved against existing Paper nodes. */
  sourcePaperLink: string;
  locator: string;
  evidenceType: string;
  confidence: string;
  strength: string;
}

export interface DeclareClaimInput {
  content: string;
  claimType: string;
  confidence: string;
  locator: string;
  /** alias → evidence_id, e.g. {"ev1": "<uuid>"}; the alias is what the LLM
   * writes into the report body, the evidence_id resolves it to an Evidence.
   * A Claim no longer cites a Paper directly — to cite a paper the LLM
   * declares an Evidence extracted from it and cites the Evidence here. */
  citesEvidenceAliases: Record<string, string>;
  /** alias → artifact_id, e.g. {"a1": "<artifact_id>"}; the alias is what
   * the LLM writes into the report body, the artifact_id resolves it to an
   * Artifact this session's code produced. Use this (not declare_evidence)
   * for code-execution findings that have no source paper. */
  citesArtifactAliases: Record<string, string>;
  /** alias → version, e.g. {"a1": 1}; pins each cited artifact alias to the
   * exact version it cites. Filled by the Node-side declare callback. */
  citesArtifactVersions?: Record<string, number>;
  /** The report Artifact this claim is asserted in; builds the states edge
   * (Artifact → Claim) so the graph can navigate report → its claims. */
  artifactId?: string;
  /** The report Artifact's version; pins the states edge to the specific
   * report version. Filled by the Node-side declare callback when available. */
  artifactVersion?: number;
}

/** One cited node surfaced back for chip rendering. Artifact chips carry the
 * cited version so opening them does not drift to the latest version. */
export interface DeclareChipEntry {
  kind: ComposerReferenceKind;
  id: string;
  label: string;
  version?: number;
}

export interface DeclareError {
  status: "error";
  /** Business code from the sidecar (no_cites_target, source_paper_not_found,
   * evidence_not_found, artifact_version_not_found) or
   * memory_graph_disabled / internal_error for availability failures. */
  code: string;
  message: string;
  /** Actionable next step surfaced to the LLM (e.g. re-call declare_evidence
   * for a missing evidence_id). Absent on availability failures. */
  instruction?: string;
}

/** Declare result: either ok (with the created id) or a structured error. */
export type DeclareResult =
  | { status: "ok"; evidenceId?: string }
  | DeclareError;

export interface DeclareClaimOk {
  status: "ok";
  claimId: string;
  /** alias → {kind, id, label}; the LLM writes these aliases into the report
   * body and the frontend turns them into clickable chips. */
  chipMap: Record<string, DeclareChipEntry>;
}

export type DeclareClaimResult = DeclareClaimOk | DeclareError;
