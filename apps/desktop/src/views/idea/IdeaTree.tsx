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
 * The research tree and one node's detail.
 *
 * Field names come from `IdeaTreeNode` as it exists: a node has no `design` or
 * `assessments` fields — those live in `stages` (stage id → `{ text, score? }`) — and a
 * legacy node has no `kind` at all. Everything the engine did not report is rendered as
 * unavailable, never as `0` or as a success:
 *
 * - `score === null` is "no score", not 0;
 * - a stage the node has not reached is missing, not empty text;
 * - `pruneReason === null` means "not pruned", which is not the same as "no reason".
 */

import type { IdeaTreeNode, IdeaTreeGraph } from "@sciencediscovery/schema";
import { TEXT } from "../../text.js";

const t = TEXT.ideaTree.detail;

export interface IdeaNodeStages {
  design: { text: string; score?: number } | undefined;
  aggregate: { text: string; score?: number } | undefined;
  /** Every stage that is neither `design` nor `aggregate`, in insertion order. */
  assessments: Array<{ stage: string; text: string; score?: number }>;
}

export function ideaNodeStages(node: IdeaTreeNode): IdeaNodeStages {
  const stages = node.stages ?? {};
  const assessments: IdeaNodeStages["assessments"] = [];
  for (const [stage, value] of Object.entries(stages)) {
    if (stage === "design" || stage === "aggregate") continue;
    if (value && typeof value.text === "string") assessments.push({ stage, text: value.text, ...(typeof value.score === "number" ? { score: value.score } : {}) });
  }
  return {
    design: stages.design,
    aggregate: stages.aggregate,
    assessments,
  };
}

export function ideaScoreText(score: number | null): string {
  return score === null ? t.unavailable : String(score);
}

/** Depth-first order, parents before children, so the tree reads top-down. */
export function ideaTreeRows(graph: IdeaTreeGraph): Array<{ node: IdeaTreeNode; depth: number }> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const roots = graph.nodes.filter((node) => !node.parentId || !byId.has(node.parentId));
  const rows: Array<{ node: IdeaTreeNode; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (node: IdeaTreeNode, depth: number) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    rows.push({ node, depth });
    for (const childId of node.childrenIds) {
      const child = byId.get(childId);
      if (child) walk(child, depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  // A node its parent forgot to list is still a node: render it rather than lose it.
  for (const node of graph.nodes) if (!seen.has(node.id)) rows.push({ node, depth: 0 });
  return rows;
}

export function IdeaTreeView({ graph, selectedId, onSelect }: { graph: IdeaTreeGraph; selectedId?: string; onSelect?: (node: IdeaTreeNode) => void }) {
  const rows = ideaTreeRows(graph);
  if (!rows.length) return <p className="idea-tree-empty">{t.empty}</p>;
  return (
    <ul className="idea-tree" aria-label={t.tree}>
      {rows.map(({ node, depth }) => (
        <li className={`idea-tree-node is-${node.status}${selectedId === node.id ? " is-selected" : ""}`} key={node.id} style={{ paddingLeft: `${depth * 16}px` }}>
          <button className="idea-tree-node-button" onClick={() => onSelect?.(node)} type="button">
            <span className="idea-tree-hypothesis">{node.hypothesis}</span>
            <span className="idea-tree-meta">
              <span>{t.status[node.status] ?? node.status}</span>
              <span>{t.search[node.searchStatus] ?? node.searchStatus}</span>
              <span>{ideaScoreText(node.score)}</span>
              {node.kind ? <span>{t.kind[node.kind] ?? node.kind}</span> : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function IdeaNodeDetail({ node }: { node: IdeaTreeNode }) {
  const stages = ideaNodeStages(node);
  return (
    <section className="idea-node-detail" aria-label={t.title}>
      <h3>{t.title}</h3>
      <p className="idea-node-hypothesis">{node.hypothesis}</p>
      <dl>
        <dt>{t.statusLabel}</dt>
        <dd>{t.status[node.status] ?? node.status}</dd>
        <dt>{t.searchLabel}</dt>
        <dd>{t.search[node.searchStatus] ?? node.searchStatus}</dd>
        <dt>{t.score}</dt>
        <dd>{ideaScoreText(node.score)}</dd>
        <dt>{t.priority}</dt>
        <dd>{String(node.priority)}</dd>
        <dt>{t.design}</dt>
        <dd>{stages.design?.text ?? t.unavailable}</dd>
        <dt>{t.aggregate}</dt>
        <dd>{stages.aggregate ? `${stages.aggregate.text} · ${ideaScoreText(stages.aggregate.score ?? null)}` : t.unavailable}</dd>
        <dt>{t.assessments}</dt>
        <dd>
          {stages.assessments.length
            ? <ul>{stages.assessments.map((entry) => <li key={entry.stage}>{entry.stage}: {entry.text} · {ideaScoreText(entry.score ?? null)}</li>)}</ul>
            : t.unavailable}
        </dd>
        <dt>{t.insight}</dt>
        <dd>{node.insight ?? t.unavailable}</dd>
        <dt>{t.pruneReason}</dt>
        <dd>{node.pruneReason ?? t.notPruned}</dd>
        <dt>{t.artifacts}</dt>
        <dd>{node.artifactRefs.length ? node.artifactRefs.join(", ") : t.unavailable}</dd>
      </dl>
    </section>
  );
}
