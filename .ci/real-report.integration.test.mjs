import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPlan } from "../test/support/tagged/plan.mjs";
import { reconcile } from "./real-report.mjs";
import { createTest } from "../test/support/tagged/compat.mjs";
import { PROVIDER_FAULT } from "../test/support/tagged/provider-fault.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64"] });

function fixturePlan() {
  return createPlan([{
    id: "journey-real-1",
    source: "test/journey-basic-real-api.spec.ts",
    sourceHash: "a".repeat(64),
    runner: "playwright",
    tags: ["category:e2e", "tier:l3", "os:linux", "arch:amd64", "fixture:standard", "isolation:fresh"],
  }], {
    revision: "fixture-revision",
    profile: "release",
    selector: "",
    targets: [{ os: "linux", arch: "amd64" }],
    execution: { backend: "jiuwenswarm", model: null, judge: null },
  });
}

async function writeShard(root, plan, results, overrides = {}) {
  const shardRoot = join(root, "real-e2e-results-basic", "e2e-real", "tagged");
  await mkdir(shardRoot, { recursive: true });
  await writeFile(join(shardRoot, "plan.json"), JSON.stringify(plan));
  await writeFile(join(shardRoot, "summary.json"), JSON.stringify({
    planDigest: plan.digest,
    status: "PASS",
    providerFaults: 0,
    results,
    ...overrides,
  }));
}

test("real CI reconciliation accepts a complete shard and preserves identity accounting", async () => {
  const root = await mkdtemp(join(tmpdir(), "real-report-integration-"));
  try {
    const plan = fixturePlan();
    await writeShard(root, plan, [{ key: plan.entries[0].key, outcome: "PASS", actualTarget: plan.entries[0].target, actualBackend: "jiuwenswarm" }]);
    const verdict = reconcile(plan, root);
    assert.equal(verdict.exitCode, 0);
    assert.equal(verdict.planned, 1);
    assert.equal(verdict.executed, 1);
    assert.equal(verdict.passed, 1);
    assert.deepEqual(verdict.problems, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real CI reconciliation preserves a product failure as executed evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "real-report-failure-"));
  try {
    const plan = fixturePlan();
    await writeShard(root, plan, [{ key: plan.entries[0].key, outcome: "FAIL", actualTarget: plan.entries[0].target, actualBackend: "jiuwenswarm" }], { status: "FAIL" });
    const verdict = reconcile(plan, root);
    assert.equal(verdict.exitCode, 1);
    assert.equal(verdict.executed, 1);
    assert.equal(verdict.failed, 1);
    assert.equal(verdict.notRun, 0);
    assert.ok(verdict.problems.some((problem) => problem.startsWith("FAIL:")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real CI reconciliation reports blocked execution separately from not-run cases", async () => {
  const root = await mkdtemp(join(tmpdir(), "real-report-blocked-"));
  try {
    const plan = fixturePlan();
    await writeShard(root, plan, [{ key: plan.entries[0].key, outcome: "BLOCKED", actualTarget: plan.entries[0].target, actualBackend: "jiuwenswarm" }], { status: "FAIL" });
    const verdict = reconcile(plan, root);
    assert.equal(verdict.exitCode, 1);
    assert.equal(verdict.executed, 0);
    assert.equal(verdict.blocked, 1);
    assert.equal(verdict.notRun, 0);
    assert.ok(verdict.problems.some((problem) => problem.startsWith("BLOCKED:")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real CI reconciliation preserves provider faults without relabeling them as product failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "real-report-provider-fault-"));
  try {
    const plan = fixturePlan();
    await writeShard(root, plan, [{ key: plan.entries[0].key, outcome: PROVIDER_FAULT, actualTarget: plan.entries[0].target, actualBackend: "jiuwenswarm" }], { status: "PROVIDER_FAULT", providerFaults: 1 });
    const verdict = reconcile(plan, root);
    assert.equal(verdict.exitCode, 1);
    assert.equal(verdict.executed, 1);
    assert.equal(verdict.failed, 0);
    assert.equal(verdict.providerFaults, 1);
    assert.equal(verdict.status, "PROVIDER_FAULT");
    assert.ok(verdict.problems.some((problem) => problem.startsWith(`${PROVIDER_FAULT}:`)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real CI reconciliation rejects a missing shard and a duplicate result", async () => {
  const root = await mkdtemp(join(tmpdir(), "real-report-missing-"));
  try {
    const plan = fixturePlan();
    const missing = reconcile(plan, root);
    assert.equal(missing.exitCode, 1);
    assert.ok(missing.problems.some((problem) => problem.includes("SHARD_EVIDENCE_MISSING")));
    await writeShard(root, plan, [
      { key: plan.entries[0].key, outcome: "PASS", actualTarget: plan.entries[0].target, actualBackend: "jiuwenswarm" },
      { key: plan.entries[0].key, outcome: "PASS", actualTarget: plan.entries[0].target, actualBackend: "jiuwenswarm" },
    ]);
    const duplicate = reconcile(plan, root);
    assert.equal(duplicate.exitCode, 1);
    assert.ok(duplicate.problems.some((problem) => problem.startsWith("DUPLICATE_RESULT:")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
