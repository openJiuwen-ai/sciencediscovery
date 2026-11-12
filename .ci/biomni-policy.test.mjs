// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTest } from '../test/support/tagged/compat.mjs';
import { evaluateSuite, temporaryVerdict, percentile, renderSuite, dataset, l5Tasks, manifestHash, validateMetrics, projectMetrics } from './biomni-gate.mjs';
import { allowsUnknownJudgeUsage, judgeTokens, MEASUREMENT_VERSION } from '../test/benchmarks/biomnibench-da/metrics.mjs';
import { caseExecutionSummary, renderCaseExecution } from './case-execution.mjs';
import { prepareRealE2EResults } from './prepare-real-e2e-results.mjs';
const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'os:windows', 'os:macos', 'arch:amd64', 'arch:arm64'] });
const policy = JSON.parse(readFileSync(new URL('./biomni-gate.json', import.meta.url)));
const historical = policy.temporary_baseline;
const baseline = { ...historical, sum_e2e_ms: historical.sum_e2e_ms * 45 / 50 };
function fixture() {
  const plan = { profile: 'release', revision: 'candidate', evaluatorRevision: 'evaluator',
    execution: { backend: 'jiuwenswarm', model: 'generator', judge: 'judge' },
    entries: l5Tasks.map(t => ({ key: t.id, id: `BiomniBench-${t.id} analysis`,
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

test('active sum budgets preserve per-case headroom without relabelling historical means or P95', () => {
  const verdict = temporaryVerdict(baseline, policy);
  for (const metric of verdict.metrics) {
    assert.equal(metric.historical_baseline, historical[metric.metric]);
    const additive = metric.metric === 'sum_e2e_ms';
    assert.equal(metric.budget_scale, additive ? 0.9 : 1);
    if (additive) {
      const rule = policy.thresholds[metric.metric];
      assert.ok(Math.abs(metric.block / 45 - historical[metric.metric] * (1 + rule.block) / 50) < 1e-6);
    } else assert.equal(metric.baseline, historical[metric.metric]);
  }
  const wrongPopulation = { ...policy, temporary_population: { reference_case_count: 50, active_case_count: 50 } };
  assert.deepEqual(temporaryVerdict(baseline, wrongPopulation).problems, ['INVALID_TEMPORARY_POPULATION_POLICY']);
});

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
  const bad = structuredClone(policy); bad.thresholds.sum_e2e_ms.block = NaN;
  assert.ok(temporaryVerdict(baseline, bad).problems.includes('INVALID_TEMPORARY_BASELINE_POLICY'));
});

test('P95 uses linear interpolation and does not substitute the maximum', () => {
  assert.equal(percentile([1, 2, 3, 4, 100], .95), 80.79999999999998);
});

test('aggregate gate reports all active tasks and does not gate individual low scores', () => {
  const { plan, documents } = fixture();
  documents[0].measurements.score = documents[0].evaluation.score = 0;
  const report = evaluateSuite(plan, documents, policy);
  assert.equal(report.status, 'temporary_baseline_passed');
  assert.equal(report.summary.mean_score, 68.44444444444444);
  assert.equal(report.case_statuses.length, 45);
  assert.equal(report.scope, 'public-45-active');
  assert.equal(report.dataset_scope, 'public-50');
  assert.equal(report.excluded_case_ids.length, 5);
  assert.equal(report.baseline_population.sum_budget_scale, 0.9);
  assert.match(renderSuite(report), /have not been remeasured/);
  assert.equal(report.non_regression_certified, false);
  assert.match(renderSuite(report), /da-3-4 \| completed/);
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

const usage = { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 };
const timeoutAttempt = { status: 'error', error_type: 'HTTPError', error: 'HTTP 524' };
function withTransportFailure(doc) {
  doc.judge_usage = { ...judgeTokens([timeoutAttempt, timeoutAttempt, { status: 'scored', usage }]), scope: 'all-evaluation-attempts' };
  doc.measurements.reported_total_tokens = doc.measurements.total_tokens;
  doc.measurements.total_tokens_basis = 'known-lower-bound';
  return doc;
}

test('524, 524, scored retains unknown spend and passes with a cost warning', () => {
  const { plan, documents } = fixture();
  withTransportFailure(documents[0]);
  const report = evaluateSuite(plan, documents, policy);
  assert.equal(report.status, 'temporary_baseline_warning');
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.warnings, ['JUDGE_USAGE_INCOMPLETE']);
  assert.equal(report.measured, 45);
  assert.equal(report.summary.total_tokens, 45 * 120);
  assert.equal(report.summary.reported_total_tokens, report.summary.total_tokens);
  assert.equal(report.summary.token_usage_complete, false);
  assert.equal(report.summary.total_tokens_basis, 'known-lower-bound');
  assert.equal(report.summary.unknown_judge_attempts, 2);
  assert.equal(report.thresholds.some(m => m.metric === 'total_tokens'), false,
    'current main policy keeps token usage diagnostic-only');
  assert.match(renderSuite(report), /≥ 120.00 \(2 attempts unknown\)/);
  assert.match(renderSuite(report), /JUDGE_USAGE_INCOMPLETE/);
  assert.equal(projectMetrics(documents[0]).judge_usage.transport_unknown_attempts, 2);
});

test('known and unknown token usage remain visible while current main policy gates other resources', () => {
  const { plan, documents } = fixture();
  withTransportFailure(documents[0]);
  const report = evaluateSuite(plan, documents, policy);
  assert.equal(report.status, 'temporary_baseline_warning');
  assert.ok(report.warnings.includes('JUDGE_USAGE_INCOMPLETE'));
  assert.equal(report.summary.reported_total_tokens, report.summary.total_tokens);
  const expensive = fixture();
  expensive.documents[0].measurements.e2e_ms = 10 ** 12;
  const blocked = evaluateSuite(expensive.plan, expensive.documents, policy);
  assert.equal(blocked.status, 'failed');
  assert.ok(blocked.problems.includes('SUM_E2E_MS_REGRESSION'));
});

test('staging and the case execution dashboard preserve known lower bounds without changing pass counts', async t => {
  const root = mkdtempSync(join(tmpdir(), 'biomni-dashboard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { plan, documents } = fixture();
  plan.entries = [ { ...plan.entries[0], tags: ['tier:l5'] } ];
  const doc = withTransportFailure(documents[0]);
  mkdirSync(join(root, '.ci-results/e2e-real'), { recursive: true });
  writeFileSync(join(root, '.ci-results/e2e-real/benchmark-metrics.json'), JSON.stringify(doc));
  await prepareRealE2EResults(root);
  const staged = readFileSync(join(root, '.tmp/real-e2e-results/e2e-real/benchmark-metrics.json'));
  mkdirSync(join(root, 'real-e2e-results-research-1'), { recursive: true });
  writeFileSync(join(root, 'real-e2e-results-research-1/benchmark-metrics.json'), staged);
  const verdict = { passed: 1, results: [{ key: doc.key, outcome: 'PASS' }] };
  const summary = caseExecutionSummary(plan, root, verdict), row = summary.table.rows[0];
  assert.equal(summary.passed, 1);
  assert.equal(row.status, 'passed');
  assert.equal(row.generated_tokens, '10');
  assert.equal(row.judge_tokens, '≥ 20');
  assert.equal(row.total_tokens, '≥ 120 (2 attempts unknown)');
  assert.match(renderCaseExecution(summary.table), /≥ 120 \(2 attempts unknown\)/);
});

test('failed requests with usage count toward known cost; missing successful or unproven usage still blocks', () => {
  const known = judgeTokens([{ ...timeoutAttempt, usage }, { status: 'scored', usage }]);
  assert.equal(known.complete, true);
  assert.equal(known.total, 40);
  for (const attempt of [
    { status: 'scored' }, { status: 'scored', failure_kind: 'network' },
    { status: 'error' }, { status: 'error', error_type: 'ValueError', error: 'Invalid JSON' },
    { status: 'error', error_type: 'HTTPError', error: 'HTTP 401' },
    { status: 'error', error_type: 'HTTPError', error: 'HTTP 429' },
    { status: 'error', failure_kind: 'network', http_status: 400 },
  ]) {
    const summary = judgeTokens([attempt, { status: 'scored', usage }]);
    assert.equal(allowsUnknownJudgeUsage(summary), false);
    const { plan, documents } = fixture();
    documents[0].judge_usage = summary;
    assert.throws(() => validateMetrics(documents[0], plan.entries[0], plan), /UNREPORTED_JUDGE_TOKENS/);
  }
  for (const attempt of [timeoutAttempt, { status: 'error', failure_kind: 'timeout' },
    { status: 'error', failure_kind: 'network' }, { status: 'error', http_status: 503 }]) {
    assert.equal(allowsUnknownJudgeUsage(judgeTokens([attempt, { status: 'scored', usage }])), true);
  }
  assert.equal(allowsUnknownJudgeUsage(judgeTokens([timeoutAttempt])), false, 'no reported usage cannot qualify');
});

test('incomplete usage cannot be labelled complete or certified as a comparable baseline', () => {
  const { plan, documents } = fixture();
  withTransportFailure(documents[0]);
  for (const bad of [
    { total_tokens_basis: 'complete' }, { reported_total_tokens: 0 },
    { total_tokens_basis: undefined },
  ]) {
    const doc = structuredClone(documents[0]); Object.assign(doc.measurements, bad);
    assert.throws(() => validateMetrics(doc, plan.entries[0], plan), /INVALID_TOKEN_USAGE_BASIS/);
  }
  const approved = { ...evaluateSuite(plan, fixture().documents, { mode: 'candidate', baseline: null }),
    status: 'approved', approved_by: 'maintainer', approved_at: '2026-11-12' };
  const compare = { mode: 'compare', score_drop_points: 0, resource_increase_ratio: 0 };
  const report = evaluateSuite(plan, documents, compare, approved);
  assert.equal(report.status, 'non_regression_warning');
  assert.equal(report.non_regression_certified, false);
  approved.cases[0] = projectMetrics(documents[0]);
  assert.match(evaluateSuite(plan, documents, compare, approved).problems.join(), /INCOMPLETE_BASELINE_TOKEN_USAGE/);
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
  assert.match(readFileSync(join(root, 'biomni-gate.md'), 'utf8'), /45\/45/);
  withTransportFailure(documents[0]);
  assert.equal(run(documents).status, 0, 'recovered scoring with unknown transport spend is a warning');
  assert.equal(JSON.parse(readFileSync(join(root, 'biomni-gate.json'))).status, 'temporary_baseline_warning');
  documents[0].measurements.generation_tokens = Math.ceil(baseline.total_tokens * 1.25);
  documents[0].measurements.total_tokens = documents[0].measurements.generation_tokens + documents[0].measurements.judge_tokens;
  documents[0].measurements.reported_total_tokens = documents[0].measurements.total_tokens;
  assert.equal(run(documents).status, 0, 'token usage is diagnostic-only under the current main policy');
  assert.equal(run(documents.slice(1)).status, 1);
  assert.equal(JSON.parse(readFileSync(join(root, 'biomni-gate.json'))).status, 'failed');
});
