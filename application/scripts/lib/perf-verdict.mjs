// perf-verdict: judge parsed component durations against the two-layer
// budget from design doc P1 sec4 (hang budget = fixed seconds; regression
// budget = baseline x tolerance). Pure functions, pinned by
// application/test/perf-budget.test.ts against the REAL 2026-11-24
// three-session measured values (signed v0.4.0 build) — the numbers in
// perf-budget.json are the measured values, and any change that stops
// rejecting the incident-shaped inputs turns the test red by name
// (pyc-budget precedent: thresholds must never loosen past the failure
// they exist to catch).
//
// Verdicts per component:
//   ok          within both layers
//   hang        over hangMs (component stuck / never ready) — hard fail
//   regression  over baseline x tolerance but under hang — warn first,
//               hard fail on 2nd consecutive run (two-strike, design sec4e)
//
// Missing data is never guessed away: a component whose event pair is
// only half present (durationMs === null) reports verdict "hang" with the
// missing event name — the ready/healthy event not arriving IS the hang
// signal. Hiding it would repeat the W25 shape: every gate green while
// the user sits on a multi-minute wait.
//
// Session kinds are judged with separate budget tables (design sec4d
// rule 3): "first" (provisioning ran: unpack, slower baselines) vs "warm"
// (short-circuited bootstrap, tight baselines). Mixing kinds is a
// guaranteed false alarm — the unpack tax only exists in first sessions.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { componentDurations, sessionKind } from "./parse-perf-timeline.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The single source of truth for budgets: application/scripts/perf-budget.json
 * (H1-H9 / R1-R12 from design doc sec4). Baselines were measured on the
 * 2026-11-24 three-session log of the signed v0.4.0 build. Keeping the
 * numbers in JSON (not here) means the gate, future CI jobs and the
 * re-baselining flow all read one file.
 */
const BUDGET_FILE = JSON.parse(readFileSync(join(here, "..", "perf-budget.json"), "utf8"));
export const BUDGETS = BUDGET_FILE.sessions;
export const TOLERANCE_RATIO = BUDGET_FILE.toleranceRatio;

/**
 * Judge one component duration against its budget line.
 * Pure; returns a verdict row (see header for the three verdicts).
 */
export function judgeComponent(component, durationMs, missing, budget, toleranceRatio = TOLERANCE_RATIO) {
  const hangMs = budget.hangMs;
  const regressionLine = Math.round(budget.baselineMs * toleranceRatio);
  if (durationMs === null || durationMs === undefined) {
    return {
      component,
      verdict: "hang",
      durationMs: null,
      budget: hangMs,
      missing: missing || "event pair incomplete",
    };
  }
  if (durationMs > hangMs) {
    return { component, verdict: "hang", durationMs, budget: hangMs };
  }
  if (durationMs > regressionLine) {
    return { component, verdict: "regression", durationMs, budget: regressionLine };
  }
  return { component, verdict: "ok", durationMs, budget: hangMs };
}

/**
 * Judge one parsed session end to end.
 *
 * @param {Array} session - one session's PerfEvent[] (splitSessions output)
 * @param {object} [budgets] - budget tables (defaults to perf-budget.json; injectable for tests)
 * @returns {{ kind: string|null, rows: Array, summary: { hang: number,
 *   regression: number, ok: number }, note?: string }}
 *   kind null (no provisioning flag seen) -> rows: [] with a note: the
 *   verdict layer refuses to guess a session kind it cannot identify.
 */
export function judgeSession(session, budgets = BUDGETS) {
  const kind = sessionKind(session);
  const durations = componentDurations(session);
  const table = kind ? budgets[kind] : null;
  if (!table) {
    return {
      kind,
      rows: [],
      summary: { hang: 0, regression: 0, ok: 0 },
      note: "session kind unknown (no bootstrapPackaged-enter flag) — refusing to guess",
    };
  }
  const rows = [];
  for (const d of durations) {
    const budget = table[d.component];
    if (!budget) continue; // unbudgeted component: parser-only, not judged
    // Warm sessions short-circuit unpack — the missing pair is expected,
    // not a hang. Only "first" sessions can hang on unpack.
    if (d.component === "unpack" && kind === "warm" && d.durationMs === null) continue;
    rows.push(judgeComponent(d.component, d.durationMs, d.missing, budget));
  }
  const summary = {
    hang: rows.filter((r) => r.verdict === "hang").length,
    regression: rows.filter((r) => r.verdict === "regression").length,
    ok: rows.filter((r) => r.verdict === "ok").length,
  };
  return { kind, rows, summary };
}

/**
 * Overall exit decision for CI (design sec4e two-strike rule).
 *   hang anywhere   -> exit 1 (hard fail, this run)
 *   regression only -> exit 0 with warning (the caller counts strikes
 *                      across runs; the 2nd consecutive one turns into a
 *                      hard fail upstream, in the CI wrapper)
 * A session judged with unknown kind adds a note but never fails the
 * run: the gate only fails on evidence, not on missing metadata.
 */
export function exitCode(judged) {
  return judged.some((j) => j.summary.hang > 0) ? 1 : 0;
}
