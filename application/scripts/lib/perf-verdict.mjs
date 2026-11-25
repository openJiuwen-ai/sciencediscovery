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
//   blocked     the pair is missing ONLY because an upstream component
//               never reached its own TO event (subordination, sec4d
//               rule 5): one jw stall paints ONE red, the rows it
//               cascades into are marked blocked, not hang
//
// Missing data is never guessed away: a component whose event pair is
// only half present (durationMs === null) reports hang (or blocked) with
// the missing event name — the ready/healthy event not arriving IS the
// hang signal. Hiding it would repeat the W25 shape: every gate green
// while the user sits on a multi-minute wait.
//
// Session kinds are judged with separate budget tables (design sec4d
// rule 3): "first" (provisioning ran) vs "warm" (short-circuited
// bootstrap). Mixing kinds is a guaranteed false alarm — the unpack tax
// only exists in copy-path sessions.

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

// Subordination map (design sec4d rule 5): when a component's FROM event
// sits downstream of another component's TO event, a missing upstream TO
// cascades into "missing" rows here. Those rows are reported `blocked`
// (attributed to the upstream hang) instead of `hang`, so one stalled
// component paints ONE red, not four (F4).
const BLOCKED_BY = {
  "agent-ready": "jw-ready",      // AGENT-READY never fires while jw is down
  "shell-ui": "agent-ready",      // loadUi-loadURL comes after AGENT-READY
  "warmup-done": "agent-ready",   // warmup starts after AGENT-READY
};

/**
 * True when the session's own lines prove the copy path did not run:
 * the warm short-circuit (unpackNeeded=false) OR the Windows in-place
 * branch (the in-place path returns before ever emitting unpack-enter;
 * see bootstrap.ts). Keyed on evidence, not on the provisioning flag,
 * because provisioning=true + in-place ALSO legitimately produces no
 * unpack pair (F2: that combination is a healthy win32 first run, and
 * must not read as a hang).
 */
function copyPathSkipped(session) {
  return session.some(
    (e) =>
      e.domain === "shell" &&
      (e.event === "bootstrap short-circuit" || e.event === "bootstrap in-place-fix-enter"),
  );
}

/**
 * Judge one component duration against its budget line.
 * Pure; returns a verdict row (see header for the verdicts).
 *
 * hangOnly: skip the regression layer entirely — used on CI machines with
 * no local baseline (regression lines are baseline-relative and only
 * meaningful on the machine the baselines were measured on; see the
 * build-machine-baseline iron rule in README-perf-budget.md). The hang
 * line is an absolute number, valid on any machine, so it stays enforced.
 */
export function judgeComponent(component, durationMs, missing, budget, toleranceRatio = TOLERANCE_RATIO, hangOnly = false) {
  const hangMs = budget.hangMs;
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
  if (hangOnly) {
    // No baseline to compare against on this machine: report the measured
    // duration for visibility, but judge only the hang layer. The row is
    // still "ok" (it passed the only layer this machine can judge).
    return { component, verdict: "ok", durationMs, budget: hangMs, note: "no baseline for this machine" };
  }
  const regressionLine = Math.round(budget.baselineMs * toleranceRatio);
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
 * @param {object} [options] - { hangOnly?: boolean } — hang-only mode for
 *   CI machines with no local baseline: the regression layer is skipped
 *   (baseline-relative lines are meaningless off the machine the baselines
 *   were measured on), the hang layer (absolute seconds) stays enforced,
 *   and rows report "no baseline for this machine".
 * @returns {{ kind: string|null, rows: Array, summary: { hang: number,
 *   regression: number, ok: number, blocked: number }, note?: string }}
 *   kind null (no provisioning flag seen) -> rows: [] with a note: the
 *   verdict layer refuses to guess a session kind it cannot identify.
 */
export function judgeSession(session, budgets = BUDGETS, options = {}) {
  const hangOnly = options.hangOnly === true;
  const kind = sessionKind(session);
  const durations = componentDurations(session);
  const table = kind ? budgets[kind] : null;
  if (!table) {
    return {
      kind,
      rows: [],
      summary: { hang: 0, regression: 0, ok: 0, blocked: 0 },
      note: "session kind unknown (no bootstrapPackaged-enter flag) — refusing to guess",
    };
  }
  const skipCopyPair = copyPathSkipped(session);
  const judgedRows = [];
  for (const d of durations) {
    const budget = table[d.component];
    if (!budget) continue; // unbudgeted component: parser-only, not judged
    // The copy path never ran (warm short-circuit, or the win32 in-place
    // branch which returns before unpack-enter): a missing unpack pair
    // is expected, not a hang (F2).
    if (d.component === "unpack" && skipCopyPair && d.durationMs === null) continue;
    judgedRows.push(judgeComponent(d.component, d.durationMs, d.missing, budget, undefined, hangOnly));
  }
  // Subordination (F4), second pass: a missing row whose pair cannot exist
  // because an upstream component's TO event never fired is a cascade,
  // not an independent hang — whatever direction its own missing half is
  // (agent-ready lacks its TO AGENT-READY; shell-ui lacks its FROM). Blocked
  // can itself be blocked (jw -> agent-ready -> shell-ui): resolve
  // transitively, the root stays the single hang.
  const byName = new Map(judgedRows.map((r) => [r.component, r]));
  const rows = judgedRows.map((row) => {
    if (row.verdict !== "hang" || row.durationMs !== null) return row;
    const upstream = BLOCKED_BY[row.component];
    if (!upstream) return row;
    const upstreamRow = byName.get(upstream);
    const upstreamStalled =
      upstreamRow && upstreamRow.verdict === "hang" && upstreamRow.durationMs === null;
    if (upstreamStalled) {
      // find the transitive root (upstream may itself be blocked)
      let root = upstream;
      let rootRow = upstreamRow;
      while (rootRow?.verdict === "blocked" && BLOCKED_BY[root]) {
        root = BLOCKED_BY[root];
        rootRow = byName.get(root);
      }
      return { ...row, verdict: "blocked", blockedBy: root };
    }
    return row;
  });
  const summary = {
    hang: rows.filter((r) => r.verdict === "hang").length,
    regression: rows.filter((r) => r.verdict === "regression").length,
    ok: rows.filter((r) => r.verdict === "ok").length,
    blocked: rows.filter((r) => r.verdict === "blocked").length,
  };
  return { kind, rows, summary };
}

/**
 * Overall exit decision for CI (design sec4e two-strike rule).
 *   exit 0  every session judged, no hang (regressions warn only)
 *   exit 1  a hang anywhere — hard fail, this run
 *   exit 3  NO session produced a verdict — nothing was measured
 * A gate that measures nothing must not report green (F1: same shape as
 * the W25 lesson — "all green" while nothing was actually checked).
 */
export function exitCode(judged) {
  if (judged.some((j) => j.summary.hang > 0)) return 1;
  if (judged.length > 0 && judged.every((j) => j.rows.length === 0)) return 3;
  return 0;
}
