// parse-perf-timeline: turn the shell.log perf instrumentation into a
// per-component duration map the timing budget gate can judge.
//
// Line shapes in a real shell.log (2026-11-24, signed v0.4.0 build):
//
//   2026-11-24T12:07:41.180Z [stack:err] [SD-PERF] stack runner-healthy +229ms
//   [SD-PERF] stack runner-spawn +7ms                          (bare, no ts)
//   2026-11-24T12:07:53.133Z [perf] AGENT-READY elapsed=18781ms watchAttempts=36
//   2026-11-24T12:07:38.435Z [perf] bootstrap enter +1ms       (shell, +Nms)
//   2026-11-24T12:07:40.517Z [perf] bootstrapPackaged total=2083ms
//   2026-11-24T12:07:54.389Z [warmup] first-chat /api/mcp/sources/reload -> 200
//
// Lines relayed through the child stderr pipe carry an ISO timestamp plus a
// "[stack:err] " prefix; lines the child wrote directly (pipe-flush race)
// arrive bare and inherit the last seen timestamp. The observed inheritance
// error is the interleave of two pipe flushes (sub-second) — far below the
// seconds-level budgets judged here.
//
// Durations are event-PAIR values, and pair arithmetic respects clock
// domains: shell / stack / jw run in different processes with independent
// Date.now() origins, so their +Nms offsets must NEVER be subtracted across
// domains. Same-domain pairs subtract offsets (exact, domain-local);
// cross-domain pairs (api-spawn[stack] -> HEALTH-200[shell],
// AGENT-READY[shell] -> warmup-first-chat[warmup]) use the ISO wall-clock
// difference of the two lines.
//
// Design mirrors pyc-budget.mjs: pure functions, pinned by
// application/test/perf-timeline.test.ts against the REAL 2026-11-24
// three-session log of the signed v0.4.0 build — the numbers in the fixtures
// are the measured values, and any parser change that stops extracting them
// turns the test red by name.

/** A single parsed perf event. */
// eslint-disable-next-line jsdoc/require-jsdoc
export function parsePerfLine(line, lastTsMs) {
  let atMs = lastTsMs;
  let rest = line;
  const tsMatch = TS_PREFIX.exec(line);
  if (tsMatch) {
    atMs = Date.parse(tsMatch[1]);
    rest = line.slice(tsMatch[0].length);
  }
  if (atMs === null || atMs === undefined) return null;

  // Relay prefixes ("[stack:err] ") contain a colon; the perf markers
  // ("[SD-PERF] ", "[perf] ", "[warmup] ") never do — so only the relay
  // is stripped and a bare line's own marker survives.
  rest = rest.replace(RELAY_PREFIX, "");

  const sj = STACK_JW_RE.exec(rest);
  if (sj) {
    return {
      domain: sj[1] === "stack" ? "stack" : "jw",
      event: sj[2],
      atMs,
      offsetMs: Number(sj[3]),
      raw: line,
    };
  }
  const sh = SHELL_RE.exec(rest);
  if (sh) {
    return { domain: "shell", event: sh[1], atMs, offsetMs: Number(sh[2]), raw: line };
  }
  if (rest.includes("[warmup] first-chat") && rest.includes("-> 200")) {
    // Only a 200 counts as warmup-done: a 5xx/timeout leaves the pair
    // missing, so the H8 budget flags it instead of silently passing.
    return { domain: "warmup", event: "warmup-first-chat", atMs, offsetMs: null, raw: line };
  }
  return null;
}

const TS_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) /;
const RELAY_PREFIX = /^\[[\w-]+:[\w.-]+\] /;
const STACK_JW_RE = /\[SD-PERF\] (stack|jw) ([\w.-]+) \+(\d+)ms/;
// Shell events can be multi-word ("bootstrap unpack-enter",
// "start-stack pre-API") and carry +Nms / elapsed=Nms / total=Nms.
const SHELL_RE = /\[perf\] (.+?) (?:\+|elapsed=|total=)(\d+)ms/;

/** Parse a whole shell.log into the perf event list, in file order. */
export function parsePerfTimeline(logText) {
  const events = [];
  let lastTsMs = null;
  for (const line of logText.split("\n")) {
    const tsMatch = TS_PREFIX.exec(line);
    if (tsMatch) lastTsMs = Date.parse(tsMatch[1]);
    const ev = parsePerfLine(line, lastTsMs);
    if (ev) events.push(ev);
  }
  return events;
}

/**
 * Slice the timeline at module-load boundaries: every shell module-load
 * starts a fresh session, so budgets are judged per session, never across
 * sessions (a warm start must never be judged against first-init budgets —
 * sessionKind() splits them by the provisioning flag).
 */
export function splitSessions(events) {
  const sessions = [];
  let current = [];
  for (const ev of events) {
    if (ev.domain === "shell" && ev.event === "module-load") {
      if (current.length) sessions.push(current);
      current = [ev];
    } else if (current.length) {
      current.push(ev);
    }
    // events before the first module-load are dropped (cannot be budgeted)
  }
  if (current.length) sessions.push(current);
  return sessions;
}

/**
 * "first" (provisioning=true: unpack + venv fix + precompile ran) or
 * "warm" (provisioning=false / short-circuit). The flag rides the
 * bootstrapPackaged-enter line; a session without it (e.g. attach mode)
 * reports null so the verdict layer can refuse to guess.
 */
export function sessionKind(session) {
  for (const ev of session) {
    if (ev.domain === "shell" && ev.event === "bootstrapPackaged-enter") {
      if (ev.raw.includes("provisioning=true")) return "first";
      if (ev.raw.includes("provisioning=false")) return "warm";
    }
  }
  return null;
}

/** A named duration, computed from one session's events. */
// eslint-disable-next-line jsdoc/require-jsdoc
export function componentDurations(session) {
  const out = [];
  for (const pair of PAIRS) {
    const fromIdx = session.findIndex(
      (e) => e.domain === pair.from[0] && e.event === pair.from[1],
    );
    if (fromIdx < 0) {
      out.push(missing(pair, "from"));
      continue;
    }
    const toIdx = session.findIndex(
      (e, i) => i > fromIdx && e.domain === pair.to[0] && e.event === pair.to[1],
    );
    if (toIdx < 0) {
      out.push(missing(pair, "to"));
      continue;
    }
    out.push({ component: pair.component, durationMs: duration(session, fromIdx, toIdx, pair) });
  }
  return out;
}

function missing(pair, end) {
  return {
    component: pair.component,
    durationMs: null,
    missing: `${end} event ${end === "from" ? pair.from[1] : pair.to[1]} (${end === "from" ? pair.from[0] : pair.to[0]}) not in log`,
  };
}

// Same domain -> offset difference (domain-local, exact). Cross domain ->
// wall-clock difference (both lines carry or inherit ISO timestamps).
function duration(session, fromIdx, toIdx, pair) {
  const from = session[fromIdx];
  const to = session[toIdx];
  if (pair.from[0] === pair.to[0] && from.offsetMs !== null && to.offsetMs !== null) {
    return to.offsetMs - from.offsetMs;
  }
  return to.atMs - from.atMs;
}

// Pair definitions. Domain pairs are [domain, eventName]; the domains may
// differ ONLY where the wall clock is the shared truth (api-ready, warmup-
// done). Component names are the budget keys in perf-budget.json.
const PAIRS = [
  { component: "shell-boot", from: ["shell", "module-load"], to: ["shell", "stack-spawned"] },
  // unpack only exists in provisioning=true sessions (H1's inner segment,
  // budget R11); warm sessions short-circuit it — reported missing on purpose.
  { component: "unpack", from: ["shell", "bootstrap unpack-enter"], to: ["shell", "bootstrap unpack-done"] },
  { component: "runner-ready", from: ["stack", "runner-spawn"], to: ["stack", "runner-healthy"] },
  { component: "memory-graph-ready", from: ["stack", "memory-graph-spawn"], to: ["stack", "memory-graph-healthy"] },
  { component: "evolve-ready", from: ["stack", "evolve-spawn"], to: ["stack", "evolve-healthy"] },
  // Cross-domain: api-spawn is stack-local, HEALTH-200 is the shell's own
  // probe — wall-clock difference is the only legal arithmetic.
  { component: "api-ready", from: ["stack", "api-spawn"], to: ["shell", "HEALTH-200"] },
  { component: "jw-ready", from: ["jw", "spawn-jw-app"], to: ["jw", "IS-UP"] },
  { component: "agent-ready", from: ["shell", "module-load"], to: ["shell", "AGENT-READY"] },
  { component: "shell-ui", from: ["shell", "AGENT-READY"], to: ["shell", "loadUi"] },
  // Cross-domain: warmup runs in the renderer/api process; only the ISO
  // timestamps line it up with the shell's AGENT-READY.
  { component: "warmup-done", from: ["shell", "AGENT-READY"], to: ["warmup", "warmup-first-chat"] },
];

export const COMPONENT_NAMES = PAIRS.map((p) => p.component);
