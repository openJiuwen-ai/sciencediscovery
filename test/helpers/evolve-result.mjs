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

/**
 * What the product actually delivers for a finished search.
 *
 * Publication is the orchestrator's rule, not an expectation a case may add:
 * `finish` hands a winner over only for `succeeded` with a result node, and
 * node 0 winning means the seed stayed best and there is no improvement to
 * save. A budget stop publishes nothing, and a succeeded run without a result
 * node has nothing to name. Each skip carries the reason the results artifact
 * needs to tell "nothing to deliver" from "delivery is missing".
 */
export function deliveryOutcome(run, bestNodeIndex) {
  if (run?.status !== "succeeded") return { skipped: true, reason: run?.status ?? "unknown" };
  if (!Number.isInteger(bestNodeIndex)) return { skipped: true, reason: "no_result_node" };
  if (bestNodeIndex === 0) return { skipped: true, reason: "seed_won" };
  return { skipped: false };
}
