// Pins the perf timing-budget gate against the REAL 2026-11-24 three-session
// log of the signed v0.4.0 build (the log the budgets were measured on).
// The numbers asserted below are the measured values:
//
//   session 1 (first, provisioning=true): shell-boot 6167ms (stack-spawned
//     elapsed), unpack 1969ms, runner 221ms, memory-graph 2858ms,
//     evolve 2852ms, api 2797ms (wall clock 12:07:41.201 -> 43.998),
//     jw 7868ms, AGENT-READY 18781ms, shell-ui 122ms (loadUi-loadURL), warmup 1256ms
//   session 2 (warm, 12:10:28): shell-boot 1577ms, runner 214ms,
//     memory-graph 640ms, evolve 1046ms, api 1660ms, jw 4845ms,
//     AGENT-READY 8456ms, shell-ui 151ms (loadUi-loadURL), warmup 533ms
//   session 3 (warm, 12:13:12): shell-boot 1516ms, runner 426ms,
//     memory-graph 653ms, evolve 1034ms, api 1481ms, jw 4782ms,
//     AGENT-READY 8178ms, shell-ui 68ms (loadUi-loadURL), warmup 713ms
//
// Any parser change that stops extracting these numbers turns a test red
// by name (pyc-budget precedent). The incident-shaped inputs pin the
// thresholds: a W25-shaped "every gate green but the user wait is minutes"
// must NOT pass — see the missing-healthy and regression tests near the end.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePerfLine,
  parsePerfTimeline,
  splitSessions,
  sessionKind,
  componentDurations,
  COMPONENT_NAMES,
} from "../scripts/lib/parse-perf-timeline.mjs";
import {
  BUDGETS,
  TOLERANCE_RATIO,
  judgeComponent,
  judgeSession,
  exitCode,
} from "../scripts/lib/perf-verdict.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// helpers

function durationRows(session) {
  return Object.fromEntries(
    componentDurations(session).map((r) => [r.component, r.durationMs]),
  );
}

// Shape-exact synthetic logs: real line shapes (timestamped relay lines,
// bare pipe-flush lines, multi-word shell events, warmup 200) with the
// 2026-11-24 measured timings, so judged rows land on the same numbers
// the budget file was built from.
function syntheticFirstSession() {
  const lines = [
    "2026-11-24T12:07:34.353Z [perf] module-load elapsed=0ms",
    "2026-11-24T12:07:34.521Z [perf] app-ready elapsed=169ms sinceModuleLoad=169ms",
    "2026-11-24T12:07:34.749Z [perf] window-created elapsed=397ms",
    "2026-11-24T12:07:37.386Z [perf] ensureBackend-enter elapsed=3034ms",
    "2026-11-24T12:07:38.433Z [perf] bootstrapPackaged-enter elapsed=4081ms provisioning=true",
    "2026-11-24T12:07:38.434Z [perf] bootstrapPackaged start",
    "2026-11-24T12:07:38.435Z [perf] bootstrap enter +1ms",
    "2026-11-24T12:07:38.440Z [perf] bootstrap unpack-enter +6ms",
    "2026-11-24T12:07:40.409Z [perf] bootstrap unpack-done +1975ms self=1969ms",
    "2026-11-24T12:07:40.517Z [perf] bootstrapPackaged-done elapsed=6165ms",
    "2026-11-24T12:07:40.519Z [perf] stack-spawned elapsed=6167ms pid=67019",
    "2026-11-24T12:07:40.952Z [stack:err] [SD-PERF] stack script-enter +0ms",
    "2026-11-24T12:07:40.959Z [stack:err] [SD-PERF] stack port-preflight-done +8ms checked=5 failures=0",
    "[SD-PERF] stack runner-spawn +8ms",
    "2026-11-24T12:07:41.180Z [stack:err] [SD-PERF] stack runner-healthy +229ms",
    "[SD-PERF] stack memory-graph-spawn +229ms",
    "[SD-PERF] stack evolve-spawn +236ms",
    "2026-11-24T12:07:41.201Z [stack:err] [SD-PERF] stack api-spawn +250ms",
    "2026-11-24T12:07:43.535Z [stack:err] [SD-PERF] jw spawn-jw-app +1687ms self=5ms pid=67073",
    "2026-11-24T12:07:43.998Z [perf] HEALTH-200 elapsed=9646ms url=http://127.0.0.1:4410/api/health",
    "2026-11-24T12:07:44.038Z [stack:err] [SD-PERF] stack memory-graph-healthy +3087ms",
    "2026-11-24T12:07:44.039Z [stack:err] [SD-PERF] stack evolve-healthy +3088ms",
    "2026-11-24T12:07:51.403Z [stack:err] [SD-PERF] jw IS-UP +9555ms loopTotal=7866ms probe#32",
    "2026-11-24T12:07:53.133Z [perf] AGENT-READY elapsed=18781ms watchAttempts=36",
    "2026-11-24T12:07:53.255Z [perf] loadUi elapsed=18899ms",
    "2026-11-24T12:07:53.259Z [perf] loadUi-loadURL elapsed=18903ms ui=http://127.0.0.1:4310",
    "2026-11-24T12:07:54.389Z [warmup] first-chat /api/mcp/sources/reload -> 200",
  ];
  const events = parsePerfTimeline(lines.join("\n"));
  return splitSessions(events)[0];
}

function syntheticWarmSession() {
  const lines = [
    "2026-11-24T12:10:28.248Z [perf] module-load elapsed=0ms",
    "2026-11-24T12:10:29.812Z [perf] bootstrapPackaged-enter elapsed=1565ms provisioning=false",
    "2026-11-24T12:10:29.821Z [perf] bootstrap short-circuit +8ms unpackNeeded=false",
    "2026-11-24T12:10:29.824Z [perf] stack-spawned elapsed=1577ms pid=69078",
    "2026-11-24T12:10:29.983Z [stack:err] [SD-PERF] stack script-enter +0ms",
    "2026-11-24T12:10:29.990Z [stack:err] [SD-PERF] stack port-preflight-done +7ms checked=5 failures=0",
    "[SD-PERF] stack runner-spawn +7ms",
    "2026-11-24T12:10:30.204Z [stack:err] [SD-PERF] stack runner-healthy +221ms",
    "[SD-PERF] stack memory-graph-spawn +221ms",
    "[SD-PERF] stack evolve-spawn +222ms",
    "2026-11-24T12:10:30.222Z [stack:err] [perf] start-stack pre-API elapsed=238ms",
    "[SD-PERF] stack api-spawn +238ms",
    "2026-11-24T12:10:30.672Z [stack:err] [SD-PERF] jw spawn-jw-app +107ms self=1ms pid=69094",
    "2026-11-24T12:10:30.844Z [stack:err] [SD-PERF] stack memory-graph-healthy +861ms",
    "2026-11-24T12:10:31.252Z [stack:err] [SD-PERF] stack evolve-healthy +1268ms",
    "2026-11-24T12:10:31.882Z [perf] HEALTH-200 elapsed=3635ms",
    "2026-11-24T12:10:35.615Z [stack:err] [SD-PERF] jw gateway-first-tcp +4943ms",
    "[SD-PERF] jw IS-UP +4952ms loopTotal=4845ms probe#20",
    "2026-11-24T12:10:36.703Z [perf] AGENT-READY elapsed=8456ms watchAttempts=19",
    "2026-11-24T12:10:36.854Z [perf] loadUi elapsed=8601ms",
    "2026-11-24T12:10:36.858Z [perf] loadUi-loadURL elapsed=8607ms ui=http://127.0.0.1:4310",
    "2026-11-24T12:10:37.236Z [warmup] first-chat /api/mcp/sources/reload -> 200",
  ];
  const events = parsePerfTimeline(lines.join("\n"));
  return splitSessions(events)[0];
}

// ---------------------------------------------------------------------------
// parser: line shapes

test("timestamped relay lines parse (stack/jw domains)", () => {
  const ev = parsePerfLine(
    "2026-11-24T12:07:41.180Z [stack:err] [SD-PERF] stack runner-healthy +229ms",
    null,
  );
  assert.equal(ev.domain, "stack");
  assert.equal(ev.event, "runner-healthy");
  assert.equal(ev.offsetMs, 229);
});

test("bare [SD-PERF] lines inherit the last seen timestamp", () => {
  const lastTs = Date.parse("2026-11-24T12:07:40.959Z");
  const ev = parsePerfLine("[SD-PERF] stack runner-spawn +8ms", lastTs);
  assert.equal(ev.domain, "stack");
  assert.equal(ev.event, "runner-spawn");
  assert.equal(ev.offsetMs, 8);
  assert.equal(ev.atMs, lastTs);
});

test("shell [perf] lines parse with multi-word event names", () => {
  const ev = parsePerfLine(
    "2026-11-24T12:07:38.440Z [perf] bootstrap unpack-enter +6ms",
    null,
  );
  assert.equal(ev.domain, "shell");
  assert.equal(ev.event, "bootstrap unpack-enter");
  assert.equal(ev.offsetMs, 6);
});

test("shell [perf] elapsed= lines parse", () => {
  const ev = parsePerfLine(
    "2026-11-24T12:07:53.133Z [perf] AGENT-READY elapsed=18781ms watchAttempts=36",
    null,
  );
  assert.equal(ev.domain, "shell");
  assert.equal(ev.event, "AGENT-READY");
  assert.equal(ev.offsetMs, 18781);
});

test("warmup only counts on a 200 response", () => {
  const ok = parsePerfLine(
    "2026-11-24T12:07:54.389Z [warmup] first-chat /api/mcp/sources/reload -> 200",
    null,
  );
  assert.ok(ok, "200 warmup line must parse");
  assert.equal(ok.domain, "warmup");
  const fail = parsePerfLine(
    "2026-11-24T12:07:54.389Z [warmup] first-chat /api/mcp/sources/reload -> 500",
    null,
  );
  assert.equal(fail, null);
});

// ---------------------------------------------------------------------------
// parser: sessions and durations

test("splitSessions slices at module-load and kind is detected", () => {
  const first = syntheticFirstSession();
  assert.equal(sessionKind(first), "first");
  const warm = syntheticWarmSession();
  assert.equal(sessionKind(warm), "warm");
});

test("first-session durations match the 2026-11-24 measured values", () => {
  const rows = durationRows(syntheticFirstSession());
  assert.equal(rows["shell-boot"], 6167);
  assert.equal(rows["unpack"], 1969);
  assert.equal(rows["runner-ready"], 221);
  assert.equal(rows["memory-graph-ready"], 2858);
  assert.equal(rows["evolve-ready"], 2852);
  assert.equal(rows["api-ready"], 2797);
  assert.equal(rows["jw-ready"], 7868);
  assert.equal(rows["agent-ready"], 18781);
  assert.equal(rows["shell-ui"], 122);
  assert.equal(rows["warmup-done"], 1256);
});

test("warm-session durations match the measured values (session 2)", () => {
  const rows = durationRows(syntheticWarmSession());
  assert.equal(rows["shell-boot"], 1577);
  assert.equal(rows["runner-ready"], 214);
  assert.equal(rows["memory-graph-ready"], 640);
  assert.equal(rows["evolve-ready"], 1046);
  assert.equal(rows["api-ready"], 1660);
  assert.equal(rows["jw-ready"], 4845);
  assert.equal(rows["agent-ready"], 8456);
  assert.equal(rows["shell-ui"], 151);
  assert.equal(rows["warmup-done"], 533);
});

// ---------------------------------------------------------------------------
// verdict: the three states and the missing-pair rule

test("judgeComponent: ok under both lines, hang over hangMs, regression between", () => {
  const budget = { hangMs: 30000, baselineMs: 6200 };
  assert.equal(judgeComponent("shell-boot", 6200, undefined, budget).verdict, "ok");
  assert.equal(judgeComponent("shell-boot", 8681, undefined, budget).verdict, "regression");
  assert.equal(judgeComponent("shell-boot", 30001, undefined, budget).verdict, "hang");
});

test("missing pair is a hang, not a pass", () => {
  const budget = { hangMs: 30000, baselineMs: 6200 };
  const row = judgeComponent("shell-boot", null, "from event module-load (shell) not in log", budget);
  assert.equal(row.verdict, "hang");
  assert.match(row.missing, /module-load/);
});

test("judgeSession judges first sessions with the first table", () => {
  const judged = judgeSession(syntheticFirstSession());
  assert.equal(judged.kind, "first");
  assert.equal(judged.summary.hang, 0);
  assert.equal(judged.summary.regression, 0);
  assert.equal(judged.summary.ok, 10);
});

test("judgeSession judges warm sessions with the warm table", () => {
  const judged = judgeSession(syntheticWarmSession());
  assert.equal(judged.kind, "warm");
  assert.equal(judged.summary.hang, 0);
  assert.equal(judged.summary.regression, 0);
  assert.equal(judged.summary.ok, 9);
});

// ---------------------------------------------------------------------------
// verdict: W25-shaped incident inputs must NOT pass

test("the missing-healthy incident shape fails (hang verdict, not green)", () => {
  // The W25-class failure: a component never reaches healthy but every
  // other line is normal. The gate must say hang, not ok.
  const warm = syntheticWarmSession();
  const filtered = warm.filter((e) => !(e.domain === "jw" && e.event === "IS-UP"));
  const judged = judgeSession(filtered);
  const jwRow = judged.rows.find((r) => r.component === "jw-ready");
  assert.equal(jwRow.verdict, "hang");
  assert.match(jwRow.missing, /IS-UP/);
});

test("a 2x regression is reported as regression (warn), not hang", () => {
  const warm = syntheticWarmSession();
  // Slow the api pair to ~4x baseline by pushing HEALTH-200 into the
  // future: wall clock grows, hang line untouched.
  const mutated = warm.map((e) =>
    e.event === "HEALTH-200" ? { ...e, atMs: e.atMs + 5000, offsetMs: e.offsetMs + 5000 } : e,
  );
  const judged = judgeSession(mutated);
  const apiRow = judged.rows.find((r) => r.component === "api-ready");
  assert.equal(apiRow.verdict, "regression");
  assert.ok(apiRow.durationMs > 6600, "mutated duration should be ~6.7s");
  assert.equal(judged.summary.hang, 0, "regression only, not a hang");
});

test("exitCode: hang anywhere fails the run, regression alone does not, nothing-judged is exit 3", () => {
  // F1: a run whose sessions produced ZERO verdict rows measured nothing
  // and must not report green — that is the W25 shape wearing a CI badge.
  const hangRun = [{ summary: { hang: 1, regression: 0, ok: 9 }, rows: [{}] }];
  const regressionRun = [{ summary: { hang: 0, regression: 2, ok: 7 }, rows: [{}, {}] }];
  const healthyRun = [{ summary: { hang: 0, regression: 0, ok: 9 }, rows: Array(9) }];
  const nothingJudgedRun = [{ summary: { hang: 0, regression: 0, ok: 0 }, rows: [] }];
  const mixedRun = [nothingJudgedRun[0], healthyRun[0]]; // one judged session suffices
  assert.equal(exitCode(hangRun), 1);
  assert.equal(exitCode(regressionRun), 0);
  assert.equal(exitCode(healthyRun), 0);
  assert.equal(exitCode(nothingJudgedRun), 3, "zero verdict rows = measured nothing = exit 3");
  assert.equal(exitCode(mixedRun), 0, "one judged session makes the run measurable");
});

// ---------------------------------------------------------------------------
// verdict: hang-only mode — CI machines with no local baseline

test("hang-only mode judges the hang layer but never reports regression", () => {
  // CI runner has no baseline measured on ITS hardware: the regression
  // layer (baseline x tolerance) is machine-relative and must not judge.
  // Take a session that WOULD be a regression under full judging and
  // assert it comes out ok under hang-only (hang line still enforced).
  const warm = syntheticWarmSession();
  const mutated = warm.map((e) =>
    e.event === "HEALTH-200" ? { ...e, atMs: e.atMs + 5000, offsetMs: e.offsetMs + 5000 } : e,
  );
  const full = judgeSession(mutated);
  assert.equal(full.rows.find((r) => r.component === "api-ready").verdict, "regression");
  const hangOnly = judgeSession(mutated, undefined, { hangOnly: true });
  const apiRow = hangOnly.rows.find((r) => r.component === "api-ready");
  assert.equal(apiRow.verdict, "ok");
  assert.match(apiRow.note, /no baseline for this machine/);
  assert.equal(hangOnly.summary.regression, 0);
  assert.equal(hangOnly.summary.hang, 0);
});

test("hang-only mode still fails a hang (absolute line, machine-independent)", () => {
  // The hang layer is fixed seconds, valid on any machine: a missing
  // IS-UP must still fail in hang-only mode, and the subordination
  // cascade must still paint ONE red (not four).
  const warm = syntheticWarmSession();
  const filtered = warm.filter(
    (e) =>
      !(
        (e.domain === "jw" && e.event === "IS-UP") ||
        (e.domain === "shell" && (e.event === "AGENT-READY" || e.event === "loadUi-loadURL" || e.event === "loadUi")) ||
        (e.domain === "warmup" && e.event === "warmup-first-chat")
      ),
  );
  const judged = judgeSession(filtered, undefined, { hangOnly: true });
  assert.equal(judged.summary.hang, 1, "the absolute hang line must still fail on a CI machine");
  assert.equal(judged.summary.blocked, 3, "subordination is mode-independent");
  assert.equal(exitCode([judged]), 1);
});

// ---------------------------------------------------------------------------
// verdict: F7 — a legitimately-disabled sidecar must not read as a hang

test("a feature-off sidecar (skipped marker) is skipped, not hang (F7)", () => {
  // SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE=0 (or a missing venv) means the
  // stack never starts memory-graph and never emits the spawn/healthy
  // pair — the stack's explicit *-skipped marker is the evidence. The
  // session is healthy; judging the absent pair as hang would false-fail
  // a documented-supported configuration and get the gate switched off.
  const warm = syntheticWarmSession();
  const withSkippedMarker = warm.map((e) =>
    e.event === "memory-graph-spawn"
      ? { domain: "stack", event: "memory-graph-skipped", atMs: e.atMs, offsetMs: e.offsetMs, raw: "[SD-PERF] stack memory-graph-skipped +2ms" }
      : e,
  ).filter((e) => e.event !== "memory-graph-healthy");
  const judged = judgeSession(withSkippedMarker);
  const mgRow = judged.rows.find((r) => r.component === "memory-graph-ready");
  assert.equal(mgRow.verdict, "skipped");
  assert.match(mgRow.note, /feature off/);
  assert.equal(judged.summary.hang, 0, "a feature-off session is healthy");
  assert.equal(judged.summary.skipped, 1);
  assert.equal(exitCode([judged]), 0);
});

test("skipped applies in hang-only mode too (CI default)", () => {
  const warm = syntheticWarmSession();
  const withSkippedMarker = warm.map((e) =>
    e.event === "memory-graph-spawn"
      ? { domain: "stack", event: "memory-graph-skipped", atMs: e.atMs, offsetMs: e.offsetMs, raw: "[SD-PERF] stack memory-graph-skipped +2ms" }
      : e,
  ).filter((e) => e.event !== "memory-graph-healthy");
  const judged = judgeSession(withSkippedMarker, undefined, { hangOnly: true });
  assert.equal(judged.rows.find((r) => r.component === "memory-graph-ready").verdict, "skipped");
  assert.equal(judged.summary.hang, 0);
});

test("the evolve twin of the skipped exemption works the same (F7)", () => {
  // SKIPPABLE carries both optional sidecars; only memory-graph had a test.
  // Pin the evolve entry so a refactor that drops it turns this red.
  const warm = syntheticWarmSession();
  const withSkippedMarker = warm.map((e) =>
    e.event === "evolve-spawn"
      ? { domain: "stack", event: "evolve-skipped", atMs: e.atMs, offsetMs: e.offsetMs, raw: "[SD-PERF] stack evolve-skipped +2ms" }
      : e,
  ).filter((e) => e.event !== "evolve-healthy");
  const judged = judgeSession(withSkippedMarker);
  const evRow = judged.rows.find((r) => r.component === "evolve-ready");
  assert.equal(evRow.verdict, "skipped");
  assert.equal(judged.summary.hang, 0);
  assert.equal(judged.summary.skipped, 1);
});

test("a skipped marker never hides a real measurement (round 6 nit)", () => {
  // A session carrying BOTH a *-skipped marker and a live measured pair
  // keeps its measurement: the marker exempts only a MISSING pair, so a
  // marker-plus-measurement session reports the measured duration, never
  // a skipped row that would hide live data.
  const warm = syntheticWarmSession();
  // inject the marker AFTER the pair so the pair stays intact
  const withBoth = [...warm, { domain: "stack", event: "evolve-skipped", atMs: 1, offsetMs: 1, raw: "[SD-PERF] stack evolve-skipped +2ms" }];
  const judged = judgeSession(withBoth);
  const evRow = judged.rows.find((r) => r.component === "evolve-ready");
  assert.notEqual(evRow.verdict, "skipped", "a measured pair is never swallowed by a marker");
  assert.ok(evRow.durationMs !== null && evRow.durationMs !== undefined, "the measurement is preserved");
  assert.equal(judged.summary.skipped, 0);
});

// ---------------------------------------------------------------------------
// verdict: F6 — blockedBy reports the ROOT, not the intermediate hop

test("blockedBy names the transitive root, not the intermediate hop (F6)", () => {
  // jw stalls -> agent-ready blocked by jw -> shell-ui blocked by agent-ready
  // (intermediate). The on-call reads blockedBy to find the cause: it must
  // say jw-ready (the root), not agent-ready (an implementation detail).
  const warm = syntheticWarmSession();
  const filtered = warm.filter(
    (e) =>
      !(
        (e.domain === "jw" && e.event === "IS-UP") ||
        (e.domain === "shell" && (e.event === "AGENT-READY" || e.event === "loadUi-loadURL" || e.event === "loadUi")) ||
        (e.domain === "warmup" && e.event === "warmup-first-chat")
      ),
  );
  const judged = judgeSession(filtered);
  const shellUiRow = judged.rows.find((r) => r.component === "shell-ui");
  assert.equal(shellUiRow.verdict, "blocked");
  assert.equal(shellUiRow.blockedBy, "jw-ready", "the ROOT cause, not the intermediate agent-ready hop");
  const warmupRow = judged.rows.find((r) => r.component === "warmup-done");
  assert.equal(warmupRow.blockedBy, "jw-ready");
});

test("the walk never crosses a HEALTHY hop: agent-ready-root shape (F12)", () => {
  // jw comes UP fine, but AGENT-READY never fires (the shell's own watch
  // stalled). The old walk went to the chain's end unconditionally, so
  // shell-ui/warmup-done said "blocked by jw-ready" — naming a component
  // that measured ok, while the real stall (agent-ready) hid among several
  // rows. The fixed walk stops at the first hop that is not itself a
  // missing-pair hang: blockedBy must say agent-ready here.
  const warm = syntheticWarmSession();
  const filtered = warm.filter(
    (e) =>
      !(
        (e.domain === "shell" && (e.event === "AGENT-READY" || e.event === "loadUi-loadURL" || e.event === "loadUi")) ||
        (e.domain === "warmup" && e.event === "warmup-first-chat")
      ),
  );
  const judged = judgeSession(filtered);
  const jwRow = judged.rows.find((r) => r.component === "jw-ready");
  assert.equal(jwRow.verdict, "ok", "precondition: jw is healthy in this shape");
  const shellUiRow = judged.rows.find((r) => r.component === "shell-ui");
  assert.equal(shellUiRow.verdict, "blocked");
  assert.equal(shellUiRow.blockedBy, "agent-ready", "the walk stops at the healthy jw hop and names the real stall");
  const warmupRow = judged.rows.find((r) => r.component === "warmup-done");
  assert.equal(warmupRow.blockedBy, "agent-ready");
});

// ---------------------------------------------------------------------------
// verdict: F13 — concurrent emitters may legally reverse a pair's order

test("a pair whose to event PRECEDES its from is a note, not a hang (F13)", () => {
  // shell-ui pairs AGENT-READY (shell's 250ms agent poll) with
  // loadUi-loadURL (void-invoked right before the watch starts) — the two
  // emitters are concurrent and either order is a healthy launch (the
  // green CI run measured 2ms between them). A reversal must surface as
  // "events out of order — measured, not judged", keeping the number,
  // never a HANG.
  const warm = syntheticWarmSession();
  // swap AGENT-READY and loadUi-loadURL in the event list: move AGENT-READY
  // to AFTER loadUi-loadURL, so the pair's to event genuinely precedes from
  const arIdx = warm.findIndex((e) => e.domain === "shell" && e.event === "AGENT-READY");
  const luIdx = warm.findIndex((e) => e.domain === "shell" && e.event === "loadUi-loadURL");
  assert.ok(arIdx >= 0 && luIdx > arIdx, "precondition: normal order in the synthetic session");
  const reversed = [...warm];
  const [ar] = reversed.splice(arIdx, 1);
  reversed.splice(luIdx, 0, ar); // AGENT-READY now sits AFTER loadUi-loadURL
  const judged = judgeSession(reversed);
  const shellUiRow = judged.rows.find((r) => r.component === "shell-ui");
  assert.equal(shellUiRow.verdict, "ok");
  assert.match(shellUiRow.note ?? "", /out of order/);
  assert.ok(shellUiRow.durationMs !== null, "the measurement is kept");
  assert.equal(judged.summary.hang, 0, "a concurrent-order launch is healthy");
  assert.equal(exitCode([judged]), 0);
});

// ---------------------------------------------------------------------------
// verdict: subordination (F4) — one upstream stall paints ONE red

test("a jw stall cascades to blocked rows, not four hangs", () => {
  const warm = syntheticWarmSession();
  // A real jw stall means jw never came up, so AGENT-READY never fired
  // either (the shell watches the agent port jw serves) — filter both,
  // plus everything downstream of AGENT-READY (loadUi-loadURL, warmup).
  const filtered = warm.filter(
    (e) =>
      !(
        (e.domain === "jw" && e.event === "IS-UP") ||
        (e.domain === "shell" && (e.event === "AGENT-READY" || e.event === "loadUi-loadURL" || e.event === "loadUi")) ||
        (e.domain === "warmup" && e.event === "warmup-first-chat")
      ),
  );
  const judged = judgeSession(filtered);
  const jwRow = judged.rows.find((r) => r.component === "jw-ready");
  assert.equal(jwRow.verdict, "hang", "the stalled component itself is the hang");
  // agent-ready's FROM is module-load (present) and its TO AGENT-READY is
  // absent because jw never came up: blocked by jw-ready, not a second hang.
  const agentRow = judged.rows.find((r) => r.component === "agent-ready");
  assert.equal(agentRow.verdict, "blocked", "agent-ready is blocked BY the jw stall");
  assert.equal(agentRow.blockedBy, "jw-ready");
  // shell-ui / warmup-done's FROM (AGENT-READY) is absent: blocked by
  // agent-ready, which itself is blocked — one root, three blocked rows,
  // exactly ONE hang for the on-call to read.
  const shellUiRow = judged.rows.find((r) => r.component === "shell-ui");
  assert.equal(shellUiRow.verdict, "blocked");
  const warmupRow = judged.rows.find((r) => r.component === "warmup-done");
  assert.equal(warmupRow.verdict, "blocked");
  assert.equal(judged.summary.hang, 1);
  assert.equal(judged.summary.blocked, 3);
});

// ---------------------------------------------------------------------------
// verdict: the win32 in-place path (F2) — no unpack pair, no false hang

test("an in-place first session (win32) does not hang on the missing unpack pair", () => {
  // provisioning=true + in-place branch: bootstrapPackaged-enter carries
  // provisioning=true (kind=first) but the copy path never ran, so there
  // is no unpack-enter/unpack-done pair. The healthy session must pass.
  const warm = syntheticWarmSession();
  const inPlace = warm.map((e) => {
    if (e.event === "bootstrapPackaged-enter") {
      return { ...e, raw: e.raw.replace("provisioning=false", "provisioning=true") };
    }
    return e;
  });
  // rename the short-circuit marker to the in-place marker (either is
  // acceptable evidence; use in-place to exercise that branch)
  for (const e of inPlace) {
    if (e.event === "bootstrap short-circuit") e.event = "bootstrap in-place-fix-enter";
    if (e.event === "bootstrapPackaged-enter") e.event = "bootstrapPackaged-enter";
  }
  const judged = judgeSession(inPlace);
  assert.equal(judged.kind, "first");
  const unpackRow = judged.rows.find((r) => r.component === "unpack");
  assert.equal(unpackRow, undefined, "no unpack row at all when the copy path is proven skipped");
  assert.equal(judged.summary.hang, 0, "healthy in-place first start must not fail");
});

// ---------------------------------------------------------------------------
// parser: shell-ui pairs same-origin events (F5)

test("shell-ui uses loadUi-loadURL (SD_PERF origin), never the legacy loadUi line", () => {
  // The pair must subtract offsets sharing sdPerfT0. loadUi is
  // Date.now()-appStartAt — a different origin — so its absence from the
  // pair is intentional and pinned here (see parse-perf-timeline.mjs).
  const warm = syntheticWarmSession();
  const rows = durationRows(warm);
  // AGENT-READY 8456 -> loadUi-loadURL 8607 = 151ms (same-origin diff)
  assert.equal(rows["shell-ui"], 151);
  // and the legacy loadUi line alone (elapsed=8601, different origin)
  // must NOT be used: remove the loadUrl-loadURL line and the pair goes
  // missing rather than silently falling back to the biased line.
  const without = warm.filter((e) => e.event !== "loadUi-loadURL");
  const withoutRows = durationRows(without);
  assert.equal(withoutRows["shell-ui"], null, "no loadUi-loadURL -> pair missing, no biased fallback");
});

// ---------------------------------------------------------------------------
// budget file integrity

test("perf-budget.json first baselines match the measured values (n=1, tight)", () => {
  const budget = JSON.parse(readFileSync(join(here, "..", "scripts", "perf-budget.json"), "utf8"));
  assert.equal(budget.toleranceRatio, 1.4);
  const first = durationRows(syntheticFirstSession());
  for (const [component, ms] of Object.entries(first)) {
    if (budget.sessions.first[component]) {
      assert.ok(
        Math.abs(budget.sessions.first[component].baselineMs - ms) <= 20,
        `first baseline ${component}: budget ${budget.sessions.first[component].baselineMs} vs measured ${ms}`,
      );
    }
  }
});

test("perf-budget.json warm baselines are exactly the n=2 session means", () => {
  // The two real warm sessions, pair-difference values, hard-pinned:
  // any change to the warm baselines must update these measured rows.
  // (session2, session3) -> mean, per component.
  const measured = {
    "shell-boot": [1577, 1516],
    "runner-ready": [214, 426],
    "memory-graph-ready": [640, 653],
    "evolve-ready": [1046, 1034],
    "api-ready": [1660, 1481],
    "jw-ready": [4845, 4782],
    "agent-ready": [8456, 8178],
    "shell-ui": [151, 68],
    "warmup-done": [533, 713],
  };
  const budget = JSON.parse(readFileSync(join(here, "..", "scripts", "perf-budget.json"), "utf8"));
  for (const [component, [s2, s3]] of Object.entries(measured)) {
    const expected = Math.round((s2 + s3) / 2);
    assert.equal(
      budget.sessions.warm[component].baselineMs,
      expected,
      `warm baseline ${component}: expected mean(${s2},${s3})=${expected}`,
    );
  }
});

test("agent-ready hang budget equals the shell's AGENT_READY_TIMEOUT_MS (read from source)", () => {
  // 180s from design sec4a H7, matching the code constant so the gate and
  // the runtime timeout blow together. F3: assert against the constant AS
  // DECLARED IN src/main.ts — a change to either side must turn this red,
  // so the coupling cannot silently rot.
  const budget = JSON.parse(readFileSync(join(here, "..", "scripts", "perf-budget.json"), "utf8"));
  const src = readFileSync(join(here, "..", "src", "main.ts"), "utf8");
  const m = /const AGENT_READY_TIMEOUT_MS = ([\d_]+);/.exec(src);
  assert.ok(m, "AGENT_READY_TIMEOUT_MS must stay declarative in src/main.ts (const, single line)");
  const declared = Number(m[1].replaceAll("_", ""));
  assert.equal(budget.sessions.first["agent-ready"].hangMs, declared);
  assert.equal(budget.sessions.warm["agent-ready"].hangMs, declared);
});

// ---------------------------------------------------------------------------
// budget file sanity (fool-proofing the JSON against bad edits)

test("every hang line sits strictly above its regression line", () => {
  // A hangMs at or below baseline x tolerance would be self-contradictory:
  // a run could regress (warn) and hang (fail) on the same number, and a
  // slightly-too-tight hang would fail runs the two-strike rule was
  // supposed to warn on first. Any budget that violates this ordering is
  // a mis-edit, caught here by name.
  const budget = JSON.parse(readFileSync(join(here, "..", "scripts", "perf-budget.json"), "utf8"));
  for (const [kind, table] of Object.entries(budget.sessions)) {
    for (const [component, line] of Object.entries(table)) {
      const regression = Math.round(line.baselineMs * budget.toleranceRatio);
      assert.ok(
        line.hangMs > regression,
        `${kind}/${component}: hangMs ${line.hangMs} must be > regression line ${regression}`,
      );
    }
  }
});

test("tolerance ratio stays inside the designed 1.2-2.0 band", () => {
  // 1.4 is the design value (sec2). Below 1.2 the gate cries wolf on
  // machine jitter; above 2.0 it stops catching the slow drift it exists
  // to catch (the frog-boiling failure mode, problems RP2). A fat-finger
  // 14 (missing dot) or 0.14 turns this red.
  const budget = JSON.parse(readFileSync(join(here, "..", "scripts", "perf-budget.json"), "utf8"));
  assert.ok(
    budget.toleranceRatio >= 1.2 && budget.toleranceRatio <= 2.0,
    `toleranceRatio ${budget.toleranceRatio} outside the 1.2-2.0 band`,
  );
  // and BUDGETS in perf-verdict.mjs must be loaded from the same file
  // (a stale or divergent copy defeats the single-source rule).
  assert.deepEqual(Object.keys(BUDGETS), Object.keys(budget.sessions), "BUDGETS keys must match the json sessions");
  for (const kind of Object.keys(budget.sessions)) {
    assert.deepEqual(
      Object.keys(BUDGETS[kind]),
      Object.keys(budget.sessions[kind]),
      `BUDGETS[${kind}] keys must match the json`,
    );
  }
});

test("every budget component exists in the parser's pair table", () => {
  // A budget entry whose component name the parser never produces is a
  // silently-dead line (it judges nothing) — same shape as the W25
  // lesson: a gate that looks present but measures nothing. The parser
  // exports COMPONENT_NAMES for exactly this cross-check.
  const budget = JSON.parse(readFileSync(join(here, "..", "scripts", "perf-budget.json"), "utf8"));
  for (const [kind, table] of Object.entries(budget.sessions)) {
    for (const component of Object.keys(table)) {
      assert.ok(
        COMPONENT_NAMES.includes(component),
        `${kind}/${component}: no parser pair produces this component — dead budget line`,
      );
    }
  }
});
