// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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
 * Resident summary — deterministic, size-capped digest of a KB's entity
 * graph for injection into the agent's context, ported from the DeepAnalyze
 * resident-summary module.
 *
 * Depth scales with engine maturity (all deterministic):
 *   - early  (small graph, no engine state): top entity names only
 *   - mid    (engine running, or a large graph without state): + definitions
 *            + support counts
 *   - converged:                             + trust levels + strongest edges
 *
 * Two formats in one section: human-readable markdown followed by a compact
 * machine-readable JSON slice (top entities + edges). Hard character cap —
 * the JSON block is dropped whole rather than truncated mid-fence.
 */

export const RESIDENT_SUMMARY_HARD_CAP = 2400;
const TOP_ENTITIES = 15;
const TOP_EDGES = 8;
/** Graphs at least this large get 'mid' depth even without an engine state. */
const LARGE_GRAPH_THRESHOLD = 100;

export interface ResidentEntity {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly description: string | null;
  readonly supportCount: number;
  readonly trustLevel: string;
}

export interface ResidentEdge {
  readonly srcId: string;
  readonly dstId: string;
  readonly type: string;
  readonly supportCount: number;
}

/** Storage port (implemented by the KE store; SQL-side top-N, no scans). */
export interface ResidentSummaryDataAccess {
  countEntities(kbId: string): Promise<number>;
  countEdges(kbId: string): Promise<number>;
  /** Persisted engine state (grow convergence) — drives the stage. */
  engineState(kbId: string): Promise<{ converged?: boolean } | null>;
  topEntitiesBySupport(kbId: string, limit: number): Promise<ResidentEntity[]>;
  topEdgesBySupport(kbId: string, limit: number): Promise<ResidentEdge[]>;
  /** Name lookup for edge endpoints outside the top set. */
  entityName(id: string): Promise<string | null>;
}

export interface ResidentSummary {
  /** Full prompt section (markdown + JSON fence). */
  readonly section: string;
  readonly stage: "early" | "mid" | "converged";
  readonly entityCount: number;
  readonly edgeCount: number;
}

/** Build the resident summary for a KB; null when the KB has no entity graph. */
export async function buildResidentSummary(
  kbId: string,
  data: ResidentSummaryDataAccess,
): Promise<ResidentSummary | null> {
  const entityCount = await data.countEntities(kbId);
  if (entityCount === 0) return null;
  const edgeCount = await data.countEdges(kbId);
  const engineState = await data.engineState(kbId);

  const stage: ResidentSummary["stage"] = engineState?.converged
    ? "converged"
    : engineState || entityCount >= LARGE_GRAPH_THRESHOLD
      ? "mid"
      : "early";

  const top = await data.topEntitiesBySupport(kbId, TOP_ENTITIES);
  // Fidelity note: the DeepAnalyze original ranked by support × (1+maturity);
  // this port ranks by plain support — no maturity factor exists here yet.

  const lines: string[] = [];
  lines.push(
    `实体关系图摘要（${entityCount} 实体 · ${edgeCount} 关系${engineState?.converged ? " · 已收敛" : ""}）：`,
  );

  if (stage === "early") {
    lines.push(top.map((entity) => entity.name).join("、") + (entityCount > TOP_ENTITIES ? " …" : ""));
  } else {
    for (const entity of top) {
      const definition = entity.description ? ` — ${entity.description}` : "";
      const trust = stage === "converged" ? ` [${entity.trustLevel}]` : "";
      lines.push(`- ${entity.name}（${entity.type}，${entity.supportCount} 篇支持）${trust}${definition}`);
    }
    if (entityCount > TOP_ENTITIES) lines.push(`- … 另有 ${entityCount - TOP_ENTITIES} 个实体`);
  }

  // Machine-readable slice
  const jsonSlice: { entities: unknown[]; edges?: unknown[] } = {
    entities: top.map((entity) => ({
      name: entity.name,
      type: entity.type,
      support: entity.supportCount,
      trust: entity.trustLevel,
    })),
  };

  if (stage === "converged") {
    const edges = await data.topEdgesBySupport(kbId, TOP_EDGES);
    // Resolve endpoint names: prefer the already-loaded top entities, fetch
    // the few outliers individually.
    const nameById = new Map(top.map((entity) => [entity.id, entity.name]));
    for (const edge of edges) {
      for (const id of [edge.srcId, edge.dstId]) {
        if (!nameById.has(id)) {
          nameById.set(id, (await data.entityName(id)) ?? "?");
        }
      }
    }
    const edgeLines = edges.map(
      (edge) => `${nameById.get(edge.srcId)} —[${edge.type}]→ ${nameById.get(edge.dstId)}（${edge.supportCount}）`,
    );
    if (edgeLines.length > 0) {
      lines.push("最强关系：");
      lines.push(...edgeLines.map((line) => `- ${line}`));
    }
    jsonSlice.edges = edges.map((edge) => ({
      src: nameById.get(edge.srcId) ?? null,
      type: edge.type,
      dst: nameById.get(edge.dstId) ?? null,
      support: edge.supportCount,
    }));
  }

  const markdown = lines.join("\n");
  const jsonBlock = `\n\`\`\`json\n${JSON.stringify(jsonSlice)}\n\`\`\``;

  let section: string;
  if (markdown.length + jsonBlock.length <= RESIDENT_SUMMARY_HARD_CAP) {
    section = markdown + jsonBlock;
  } else if (markdown.length <= RESIDENT_SUMMARY_HARD_CAP) {
    // Drop the JSON block whole rather than truncating it mid-fence.
    section = markdown;
  } else {
    section = markdown.slice(0, RESIDENT_SUMMARY_HARD_CAP) + "\n…（摘要已截断，用 concept_explore / deep_dive 查询细节）";
  }

  return { section, stage, entityCount, edgeCount };
}
