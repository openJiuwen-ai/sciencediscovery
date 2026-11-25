// perf-gate: run the timing-budget gate over a shell.log.
//
// This is the CLI wrapper the build's smoke step (build-mac.sh step 6, and
// the future Windows twin) calls after a first-launch run: it parses the
// log, judges every session against perf-budget.json and prints a
// human-readable report. Exit code is the verdict:
//
//   0  all sessions judged, no hang (regressions are WARNED but do not
//      fail a single run — the two-strike rule counts consecutive runs;
//      see scripts/lib/perf-verdict.mjs for the escalation design)
//   1  any hang (component over its hangMs budget, or a pair whose
//      ready/healthy event never arrived — that IS the hang signal)
//   2  usage error (no log file, unreadable, or no sessions found)
//   3  sessions exist but NONE was judged (zero verdict rows) — the
//      gate measured nothing and must not report green (F1: a log with
//      no recognizable kind flag is evidence of a coverage gap, not a
//      pass; the wizard/reuse shell paths currently emit no kind flag —
//      see perf-verdict.mjs sessionKind note)
//
// Usage (from application/, or anywhere — paths are argv-based):
//   node scripts/perf-gate.mjs <path-to-shell.log>
//   node scripts/perf-gate.mjs <log> --json          (machine output)
//   node scripts/perf-gate.mjs <log> --fail-on-regression
//        (escalate regressions to exit 1 for release runs / two-strike
//         counting; a wrapper may pass this on the 2nd consecutive run)
//   node scripts/perf-gate.mjs <log> --hang-only
//        (CI machines with NO local baseline: judge only the absolute
//         hang layer — regression lines are baseline-relative and only
//         meaningful on the machine the baselines were measured on, so
//         they are reported "no baseline for this machine" instead of
//         being judged; first-run CI data collection sets a baseline
//         later, P3-2)
//
// Pure reading and judging: this script never mutates the log, never
// writes baselines (refreshing baselines is the release-run flow, P3-2)
// and never touches the budget file beyond reading it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePerfTimeline, splitSessions } from "./lib/parse-perf-timeline.mjs";
import { judgeSession, exitCode, BUDGETS, TOLERANCE_RATIO } from "./lib/perf-verdict.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`usage: node scripts/perf-gate.mjs <shell.log> [--json] [--fail-on-regression] [--hang-only]`);
}

function failUsage(msg) {
  console.error(`perf-gate: ${msg}`);
  usage();
  process.exit(2);
}

// --- argv -------------------------------------------------------------------
const argv = process.argv.slice(2);
const jsonOut = argv.includes("--json");
const failOnRegression = argv.includes("--fail-on-regression");
const hangOnly = argv.includes("--hang-only");
const logPath = argv.find((a) => !a.startsWith("--"));
if (!logPath) failUsage("missing <shell.log> path");

let logText;
try {
  logText = readFileSync(logPath, "utf8");
} catch (e) {
  failUsage(`cannot read ${logPath}: ${e.message}`);
}

// --- parse and judge ---------------------------------------------------------
const sessions = splitSessions(parsePerfTimeline(logText));
if (sessions.length === 0) {
  failUsage(`no perf sessions found in ${logPath} (no [perf] module-load line?)`);
}
const judged = sessions.map((s) => judgeSession(s, undefined, { hangOnly }));
const code = exitCode(judged);
const escalated =
  failOnRegression && judged.some((j) => j.summary.regression > 0) ? 1 : code;

// --- report ------------------------------------------------------------------
if (jsonOut) {
  console.log(
    JSON.stringify(
      {
        log: logPath,
        toleranceRatio: TOLERANCE_RATIO,
        budgetSource: join(here, "perf-budget.json"),
        sessions: judged,
        exitCode: escalated,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`perf-gate: ${logPath}`);
  console.log(`  budgets: perf-budget.json (tolerance x${TOLERANCE_RATIO})`);
  if (hangOnly) console.log("  mode: hang-only (no local baseline on this machine — regression layer skipped)");
  for (const [i, j] of judged.entries()) {
    const label = `session ${i + 1} [${j.kind ?? "unknown"}]`;
    if (j.note) {
      console.log(`  ${label}: ${j.note}`);
      continue;
    }
    const verdict =
      j.summary.hang > 0 ? "HANG" : j.summary.regression > 0 ? "REGRESSION" : "ok";
    const blockedNote = j.summary.blocked > 0 ? `, blocked ${j.summary.blocked}` : "";
    const skippedNote = j.summary.skipped > 0 ? `, skipped ${j.summary.skipped}` : "";
    console.log(`  ${label}: ${verdict}  (ok ${j.summary.ok}, regression ${j.summary.regression}, hang ${j.summary.hang}${blockedNote}${skippedNote})`);
    for (const r of j.rows) {
      const ms = r.durationMs === null ? "missing" : `${r.durationMs}ms`;
      const line = `      ${r.component.padEnd(22)} ${String(ms).padStart(10)}  (budget ${r.budget}ms)`;
      if (r.verdict === "ok") console.log(r.note ? `${line}  <- ${r.note}` : line);
      else if (r.verdict === "skipped") console.log(`  SKP ${line}  <- ${r.note}`);
      else if (r.verdict === "regression") console.log(`  REG ${line}`);
      else if (r.verdict === "blocked") console.log(`  BLK ${line}  <- blocked by ${r.blockedBy}`);
      else console.log(`  HANG ${line}${r.missing ? `  <- ${r.missing}` : ""}`);
    }
  }
  if (escalated === 1 && code === 0) {
    console.log("  (escalated: --fail-on-regression and regressions present)");
  }
}

process.exit(escalated);
