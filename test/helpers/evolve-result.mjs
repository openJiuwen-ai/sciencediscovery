// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

/** Read the search's own scores, never infer quality from its terminal status. */
export function evolutionScorecard(run, records) {
  const events = records.map(record => record.event);
  const seeded = events.find(event => event.type === "seeded");
  const finished = events.findLast(event => event.type === "search_finished");
  const bestIndex = finished?.bestNodeIndex;
  const evaluated = events.findLast(event => event.type === "evaluated" && event.nodeIndex === bestIndex);
  const finite = value => typeof value === "number" && Number.isFinite(value) ? value : null;
  const score = finite(finished?.bestTestScore);
  return {
    schema_version: 1, evaluator: "evolution-held-out-test", gating: false,
    status: score === null ? "unavailable" : "scored", score,
    baseline_gate_score: finite(seeded?.baselineScore),
    best_gate_score: bestIndex === 0 ? finite(seeded?.baselineScore) : finite(evaluated?.gateScore),
    search_status: run.status, run_id: run.id, scorecard: run.goal.scorecard,
    best_node_index: bestIndex ?? null, stop_reason: finished?.stopReason ?? null,
    notes: ["Scores use this run's frozen evaluator; do not compare different evaluators as if they were identical.",
      ...(score === null ? ["No finite held-out test score was returned; gate score is shown separately and is not substituted."] : [])],
  };
}
