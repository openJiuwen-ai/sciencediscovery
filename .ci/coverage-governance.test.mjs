import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTest } from "../test/support/tagged/compat.mjs";
import { combinationJourneyProblems } from "./combination-journeys.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

test("overlap report is reviewable and does not delete shared evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "overlap-report-"));
  try {
    const output = join(root, "overlap.json");
    const result = spawnSync(process.execPath, [resolve(".ci/overlap-report.mjs")], { env: { ...process.env, OVERLAP_REPORT: output }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(typeof report.sourceEntries, "number");
    assert.ok(Array.isArray(report.duplicateEvidence));
    assert.match(report.policy, /never deleted/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("combination journey contract remains complete", async () => {
  assert.deepEqual(await combinationJourneyProblems(), []);
});
