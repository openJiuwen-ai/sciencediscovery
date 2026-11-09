// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createTest } from '../test/support/tagged/compat.mjs';
import { createPlan, subplan, verifyResults } from '../test/support/tagged/plan.mjs';
import { realShards } from '../test/support/tagged/execution.mjs';
import { prepareRealE2EResults } from './prepare-real-e2e-results.mjs';
import { caseExecutionSummary, compactTokens, executionMeasurements, renderCaseExecution } from './case-execution.mjs';

const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });
const repository = fileURLToPath(new URL('../', import.meta.url));
const privateText = 'PRIVATE_FIXTURE-secret-and-model-answer';
const catalog = [
  ['DRB-58', 'deepresearchbench-swarm'], ['DRB-59', 'deepresearchbench-swarm'],
  ['PUCT-COMPRESS', 'evolve-compression-real'], ['TC-E2E-01', 'science-research-team-real'],
  ['BiomniBench-da-1-3', 'biomnibench-da-swarm'], ['basic API journey', 'basic-real'],
].map(([name, file]) => ({ id: `playwright:test/${file}.spec.ts::${encodeURIComponent(name + ' journey')}`,
  source: `test/${file}.spec.ts`, sourceHash: 'a'.repeat(64), runner: 'playwright',
  tags: ['category:e2e', 'model:real', 'os:linux', 'arch:amd64', 'tier:l4'] }));
function planFor(profile) {
  const plan = createPlan(catalog, { revision: 'candidate', profile, targets: [{ os: 'linux', arch: 'amd64' }],
    execution: { backend: 'jiuwenswarm', model: 'generator', judge: 'judge' } });
  return subplan(plan, catalog.map(c => plan.entries.find(e => e.id === c.id)));
}
const save = (path, doc) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(doc)); };
function workspace(t) {
  mkdirSync(tmpdir(), { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'case-execution-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('daily/release retain every selected case in start order with safe, final display cells', async t => {
  for (const profile of ['daily', 'release']) {
    const root = workspace(t), plan = planFor(profile);
    const results = plan.entries.slice(0, -1).map((e, i) => ({ key: e.key, outcome: i === 1 ? 'FAIL' : 'PASS', actualTarget: e.target, actualBackend: e.backend }));
    const verdict = verifyResults(plan, results);
    const docs = [
      { case_id: 58, started_at: '2026-01-01T10:02:00Z', generation_duration_ms: 90000,
        evaluation: { overall_score: 0, total_score: 99, score: 98, race: { overall_score: 123 } },
        generation_usage: { totals: { outputTokens: 34200, totalTokens: 14500000, token: privateText }, invocations: [{ answer: privateText }] } },
      { case_id: 59, started_at: '2026-01-01T10:01:00Z', integration_status: 'failed',
        evaluation: { overall_score: null, total_score: 87.5, score: 77 }, usage: { total_tokens: 1234 } },
      { case: 'PUCT-COMPRESS', started_at: '2026-01-01T10:03:00Z', evaluation: { score: .7 },
        llm_evaluation: { total_score: 86.25, gating: false, response: privateText } },
      { case: 'TC-E2E-01', started_at: privateText, evaluation: { race: { overall_score: 99 } }, generation_duration_ms: privateText },
      { benchmark: 'biomnibench-da', case_id: 'da-1-3', key: plan.entries[4].key, evaluation: { score: 80 },
        measurements: { generation_tokens: 10000, generation_output_tokens: 900, judge_tokens: 2000, total_tokens: 12000,
          peak_rss_bytes: 2.5 * 1024 ** 3, tool_calls: 7, e2e_ms: 600000 } },
    ];
    for (const [i, shard] of realShards(plan).entries()) {
      const worker = join(root, `real-e2e-results-${shard.name}`);
      if (docs[i]) {
        // Exercise the actual publication boundary before aggregation.
        const raw = join(root, `raw-${i}`);
        save(join(raw, '.ci-results/e2e-real/benchmark-metrics.json'), { ...docs[i], prompt: privateText, response: privateText,
          trace: privateText, error: privateText, assertions: [privateText], credentials: { api_key: privateText } });
        await prepareRealE2EResults(raw);
        const safe = JSON.parse(readFileSync(join(raw, '.tmp/real-e2e-results/e2e-real/benchmark-metrics.json')));
        save(join(worker, 'e2e-real/benchmark-metrics.json'), safe);
      }
    }
    const summary = caseExecutionSummary(plan, root, verdict), rows = summary.table.rows;
    assert.deepEqual(summary.table.columns.map(c => c.label), ['#', 'case', 'status', 'score', 'peak memory GB',
      'generated tokens', 'judge tokens', 'total tokens', 'tool calls', 'duration min']);
    assert.deepEqual(rows.map(r => r.case), ['DRB-59', 'DRB-58', 'PUCT-COMPRESS', 'da-1-3', plan.entries[5].id, 'TC-E2E-01']);
    assert.deepEqual(rows.map(r => r.order), ['1', '2', '3', '4', '5', '6']);
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].score, '87.5');
    assert.deepEqual([rows[0].generated_tokens, rows[0].judge_tokens, rows[0].total_tokens], ['n/a', 'n/a', '1.2K']);
    assert.deepEqual([rows[1].score, rows[1].duration_min, rows[1].generated_tokens, rows[1].total_tokens], ['0', '1.5', '34.2K', '14.5M']);
    assert.equal(rows[2].score, '0.7', 'never use PUCT review');
    assert.equal(rows[5].score, 'n/a', 'never use nested RACE score');
    assert.equal(rows[5].duration_min, 'n/a');
    assert.deepEqual([rows[3].peak_memory_gb, rows[3].generated_tokens, rows[3].judge_tokens, rows[3].tool_calls, rows[3].duration_min], ['2.50', '900', '2.0K', '7', 'n/a']);
    assert.equal(rows[4].status, 'not_run');
    assert.ok(Object.entries(rows[4]).filter(([key]) => !['case', 'status', 'order'].includes(key)).every(([, value]) => value === 'n/a'));
    assert.equal(summary.tests, summary.passed + summary.failed + summary.skipped + summary.flaky);
    assert.doesNotMatch(renderCaseExecution(summary.table) + JSON.stringify(summary), /PRIVATE_FIXTURE|86\.25|123|600000/);
    // The CLI publishes the same table into both files and appends the job summary.
    save(join(root, 'plan.json'), plan); save(join(root, 'verdict.json'), verdict);
    const step = join(root, 'job.md'), output = join(root, 'published');
    writeFileSync(step, 'Existing slice and PUCT summaries\n');
    const run = spawnSync(process.execPath, [join(repository, '.ci/case-execution.mjs'), join(root, 'plan.json'), root, output],
      { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: step } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(output, 'dashboard-summary.json'))), summary);
    const markdown = readFileSync(join(output, 'case-execution-details.md'), 'utf8');
    assert.equal(markdown, renderCaseExecution(summary.table));
    assert.equal(readFileSync(step, 'utf8'), 'Existing slice and PUCT summaries\n' + markdown);
  }
});

test('optional measurements accept recorded zero and reject invalid numbers without inventing splits', () => {
  assert.deepEqual(executionMeasurements({ usage: { total_tokens: 5000 } }), { total_tokens: 5000 });
  assert.deepEqual(executionMeasurements({ measurements: { tool_calls: 0, peak_rss_bytes: 0 },
    usage: { outputTokens: -1, totalTokens: '123' }, judge_usage: { total_tokens: NaN } }), { tool_calls: 0, peak_rss_bytes: 0 });
  assert.deepEqual([undefined, null, NaN, Infinity, -1, '1000', 999, 1000, 34200, 14500000].map(compactTokens),
    ['n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', '999', '1.0K', '34.2K', '14.5M']);
});

test('optional cells cannot change a passing gate; missing/duplicate evidence stays visible', t => {
  const root = workspace(t), plan = planFor('daily');
  const verdict = verifyResults(plan, plan.entries.map(e => ({ key: e.key, outcome: 'PASS', actualTarget: e.target, actualBackend: e.backend })));
  const before = structuredClone(verdict), summary = caseExecutionSummary(plan, root, verdict);
  assert.equal(summary.passed, plan.entries.length);
  assert.ok(summary.table.rows.every(row => row.duration_min === 'n/a'));
  assert.deepEqual(verdict, before);
  const path = join(root, 'real-e2e-results-research-1');
  save(join(path, 'a/benchmark-metrics.json'), { case_id: 58, generation_duration_ms: 60000 });
  save(join(path, 'b/benchmark-metrics.json'), { case_id: 58, generation_duration_ms: 120000 });
  assert.equal(caseExecutionSummary(plan, root, verdict).table.rows.find(row => row.case === 'DRB-58').duration_min, 'n/a');
});

test('merge/pr never produce a table or either publication file', t => {
  const root = workspace(t);
  for (const profile of ['merge', 'pr']) {
    const plan = planFor(profile); save(join(root, 'plan.json'), plan);
    assert.equal(caseExecutionSummary(plan, root, {}), undefined);
    const output = join(root, profile);
    const run = spawnSync(process.execPath, [join(repository, '.ci/case-execution.mjs'), join(root, 'plan.json'), root, output]);
    assert.equal(run.status, 0);
    assert.equal(existsSync(output), false);
  }
});

test('workflows publish after staging, upload through existing results, and show the Nightly table even on failure', () => {
  const real = readFileSync(join(repository, '.github/workflows/real-e2e.yml'), 'utf8');
  const job = real.split('  real-report:\n')[1];
  const steps = job.split(/\n(?=      - )/);
  const generate = steps.find(step => step.includes('name: Summarize case execution'));
  const upload = steps.find(step => step.includes('name: Upload case execution details'));
  for (const step of [generate, upload]) {
    const expression = step.match(/if: (.+)/)[1];
    for (const profile of ['daily', 'release', 'merge', 'pr']) {
      assert.equal(runInNewContext(expression, { always: () => true, inputs: { profile } }), ['daily', 'release'].includes(profile));
    }
  }
  assert.ok(job.indexOf('Stage combined real E2E scores') < job.indexOf('Summarize case execution'));
  assert.ok(job.indexOf('Summarize case execution') < job.indexOf('Upload combined real E2E results'));
  assert.match(generate, /\.ci-real-plan\/plan.json \.ci-real-results \.tmp\/real-e2e-results/);
  assert.match(job, /name: real-e2e-results\n\s+path: \.tmp\/real-e2e-results/);
  assert.match(upload, /name: case-execution-details.md\n\s+path: \.tmp\/real-e2e-results\/case-execution-details.md/);
  const nightly = readFileSync(join(repository, '.github/workflows/nightly.yml'), 'utf8');
  assert.match(nightly, /name: case-execution-details.md\n\s+path: case-execution/);
  assert.match(nightly, /cat case-execution\/case-execution-details.md/);
  assert.match(nightly, /\[\[ "\$\{RESULT\}" == "success" \]\]/);
});
