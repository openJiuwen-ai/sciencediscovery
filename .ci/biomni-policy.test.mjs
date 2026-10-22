// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTest } from '../test/support/tagged/compat.mjs';
import { evaluateSuite, temporaryVerdict, percentile, renderSuite, dataset, manifestHash } from './biomni-gate.mjs';
import { MEASUREMENT_VERSION } from '../test/benchmarks/biomnibench-da/metrics.mjs';
const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'os:windows', 'os:macos', 'arch:amd64', 'arch:arm64'] });
const policy = JSON.parse(readFileSync(new URL('./biomni-gate.json', import.meta.url)));
const baseline = policy.temporary_baseline;
function fixture() {
  const plan = { profile: 'release', revision: 'candidate', evaluatorRevision: 'evaluator',
    execution: { backend: 'jiuwenswarm', model: 'generator', judge: 'judge' },
    entries: dataset.tasks.map(t => ({ key: t.id, id: `BiomniBench-${t.id} analysis`,
      source: 'test/biomnibench-da-swarm.spec.ts', target: { os: 'linux', arch: 'arm64' } })) };
  const documents = plan.entries.map(e => ({ schema_version: 2, benchmark: 'biomnibench-da', case_id: e.key, key: e.key,
    revision: plan.revision, integration_status: 'passed', evaluation: { status: 'scored', score: 70, gating: true },
    identity: { dataset_revision: dataset.revision, manifest_sha256: manifestHash, measurement_version: MEASUREMENT_VERSION,
      evaluator_revision: 'evaluator', backend: 'jiuwenswarm', generator_model: 'generator', judge_model: 'judge',
      run_budget_ms: 100, workspace_budget_bytes: 100, machine: { os: 'linux', arch: 'arm64', cpu: 'cpu', cores: 8, memory_bytes: 100, kernel: 'kernel', node: 'node' } },
    measurements: { score: 70, tool_calls: 40, tool_rounds: 30, peak_rss_bytes: 5 * 1024 ** 3, e2e_ms: 1000,
      generation_tokens: 100, judge_tokens: 20, total_tokens: 120, judge_ms: 100, generation_input_tokens: 90,
      generation_output_tokens: 10, judge_input_tokens: 10, judge_output_tokens: 10,
      memory_samples: 2, memory_interval_ms: 1000, memory_scope: 'isolated-local-worker-rss-sum' } }));
  return { plan, documents };
}

test('score boundaries are inclusive and improvements do not warn', () => {
  assert.equal(temporaryVerdict(baseline, policy).warnings.length, 0);
  assert.deepEqual(temporaryVerdict({ ...baseline, mean_score: 64.7 }, policy).warnings, ['MEAN_SCORE_WARNING']);
  assert.deepEqual(temporaryVerdict({ ...baseline, mean_score: 62.7 }, policy).problems, ['MEAN_SCORE_REGRESSION']);
  assert.equal(temporaryVerdict({ ...baseline, mean_score: 90 }, policy).warnings.length, 0);
});

test('each resource has independent inclusive warning and block boundaries', () => {
  const initial = temporaryVerdict(baseline, policy);
  for (const metric of initial.metrics.filter(m => m.metric !== 'mean_score')) {
    const warning = temporaryVerdict({ ...baseline, [metric.metric]: metric.warning }, policy);
    assert.equal(warning.metrics.find(m => m.metric === metric.metric).status, 'warning');
    const blocked = temporaryVerdict({ ...baseline, [metric.metric]: metric.block }, policy);
    assert.equal(blocked.metrics.find(m => m.metric === metric.metric).status, 'blocked');
  }
  const bad = structuredClone(policy); bad.thresholds.total_tokens.block = NaN;
  assert.ok(temporaryVerdict(baseline, bad).problems.includes('INVALID_TEMPORARY_BASELINE_POLICY'));
});

test('P95 uses linear interpolation and does not substitute the maximum', () => {
  assert.equal(percentile([1, 2, 3, 4, 100], .95), 80.79999999999998);
});

test('aggregate gate reports all fifty tasks and does not gate individual low scores', () => {
  const { plan, documents } = fixture();
  documents[0].measurements.score = documents[0].evaluation.score = 0;
  const report = evaluateSuite(plan, documents, policy);
  assert.equal(report.status, 'temporary_baseline_passed');
  assert.equal(report.summary.mean_score, 68.6);
  assert.equal(report.case_statuses.length, 50);
  assert.equal(report.non_regression_certified, false);
  assert.match(renderSuite(report), /da-1-3 \| completed/);
});

test('missing task prevents certification and remains visible in the per-task report', () => {
  const { plan, documents } = fixture(); documents.pop();
  const report = evaluateSuite(plan, documents, policy);
  assert.equal(report.status, 'failed');
  assert.equal(report.summary_complete, false);
  assert.equal(report.case_statuses.filter(c => c.status === 'incomplete').length, 1);
  assert.ok(report.thresholds.every(t => t.status === 'incomplete'));
});

test('evaluation failure and unknown usage expose metrics without claiming completion', () => {
  const { plan, documents } = fixture();
  documents[0].judge_usage = { complete: false };
  const report = evaluateSuite(plan, documents, policy);
  assert.equal(report.case_statuses[0].reason, 'UNREPORTED_JUDGE_TOKENS');
  assert.equal(report.case_statuses[0].measurements.score, 70);
  assert.equal(report.case_statuses[0].status, 'incomplete');
});

test('serial CLI emits both JSON and Markdown, and returns failure for an incomplete suite', t => {
  const root = mkdtempSync(join(tmpdir(), 'biomni-report-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const { plan, documents } = fixture();
  writeFileSync(join(root, 'plan.json'), JSON.stringify(plan));
  const cli = fileURLToPath(new URL('./biomni-suite-report.mjs', import.meta.url));
  const run = docs => {
    writeFileSync(join(root, 'metrics.json'), JSON.stringify(docs));
    return spawnSync(process.execPath, [cli, join(root, 'plan.json'), join(root, 'metrics.json'), root], { encoding: 'utf8' });
  };
  assert.equal(run(documents).status, 0);
  assert.match(readFileSync(join(root, 'biomni-gate.md'), 'utf8'), /50\/50/);
  assert.equal(run(documents.slice(1)).status, 1);
  assert.equal(JSON.parse(readFileSync(join(root, 'biomni-gate.json'))).status, 'failed');
});
