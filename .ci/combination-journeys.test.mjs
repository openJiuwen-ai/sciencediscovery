import assert from "node:assert/strict";
import { reconcileCombinationBrowserEvidence } from "./combination-browser-evidence.mjs";
import { createTest } from "../test/support/tagged/compat.mjs";
import { combinationJourneyProblems, deterministicJourneyProblems, loadCombinationJourneys, runDeterministicJourney } from "./combination-journeys.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"] });

test("overlap report is reviewable and does not delete shared evidence", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "overlap-report-"));
  try {
    const output = join(root, "overlap.json");
    const result = spawnSync(process.execPath, [resolve(".ci/overlap-report.mjs")], { env: { ...process.env, OVERLAP_REPORT: output }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(typeof report.sourceEntries, "number");
    assert.ok(Array.isArray(report.duplicateEvidence));
    assert.match(report.policy, /never deleted/);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("combination journey contract remains complete", async () => {
  assert.deepEqual(await combinationJourneyProblems(), []);
});


test("combination execution writes an auditable result artifact", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "combination-results-"));
  try {
    const output = join(root, "summary.json");
    const result = spawnSync(process.execPath, [resolve(".ci/run-combination-journeys.mjs")], {
      env: { ...process.env, COMBINATION_RESULTS: output },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(await readFile(output, "utf8"));
    assert.equal(summary.status, "passed");
    assert.equal(summary.journeys.length, 6);
    assert.ok(summary.journeys.every((journey) => journey.executedFaults.length >= 2 && journey.executedAssertions.length >= 3));
    assert.ok(summary.journeys.every((journey) => journey.realFixture?.status === "passed" && journey.realFixture.calls >= 3));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("all six combination journeys execute every declared fault and assertion", async () => {
  for (const journey of await loadCombinationJourneys()) {
    const result = runDeterministicJourney(journey.id, journey);
    assert.deepEqual(deterministicJourneyProblems(result, journey), []);
    assert.equal(result.state.status, "completed");
  }
});


test("combination product report requires a single passing result for each planned browser identity", async () => {
  const journeys = await loadCombinationJourneys();
  const sources = [...new Set(journeys.flatMap(({ productBrowserSpecs }) => productBrowserSpecs))];
  const target = { os: "linux", arch: "amd64" };
  const entries = sources.map((source) => ({ source, key: source, runner: "playwright", target, backend: "jiuwenswarm" }));
  const plan = { entries, revision: "candidate", digest: "plan" };
  const results = entries.map(({ key }) => ({ key, outcome: "PASS", actualTarget: target, actualBackend: "jiuwenswarm" }));
  assert.equal(reconcileCombinationBrowserEvidence(journeys, plan, results).status, "PASS");
  const [first, ...rest] = results;
  for (const [actual, expected] of [
    [[], "NOT_RUN"],
    [[{ ...first, outcome: "SKIPPED" }], "SKIPPED"],
    [[first, first], "DUPLICATE"],
    [[{ ...first, actualBackend: "legacy" }], "MISMATCH"],
  ]) {
    const report = reconcileCombinationBrowserEvidence(journeys, plan, [...actual, ...rest]);
    assert.equal(report.status, "FAIL");
    assert.equal(report.evidence[0].specs[0].cases[0].outcome, expected);
  }
  const missing = reconcileCombinationBrowserEvidence(journeys, { ...plan, entries: entries.slice(1) }, results);
  assert.equal(missing.status, "FAIL");
  assert.deepEqual(missing.evidence[0].specs[0].cases, []);
});
