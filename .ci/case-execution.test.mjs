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
import { caseIdentity, collectCaseMeasurements, sessionUsageTokens } from '../test/helpers/case-measurements.mjs';

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
        generation_usage: { totals: { invocationCount: 1, outputTokens: 34200, totalTokens: 14500000, token: privateText },
          invocations: [{ usageStatus: 'reported', inputTokens: 14465800, outputTokens: 34200, totalTokens: 14500000, answer: privateText }] } },
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

const reported = (input, output, total = input + output) => ({ usageStatus: 'reported', inputTokens: input, outputTokens: output, totalTokens: total });
const unreported = { usageStatus: 'provider-not-reported', inputTokens: null, outputTokens: null, totalTokens: null };
const usageSummary = calls => ({ sessionId: 's', totals: { invocationCount: calls.length }, invocations: calls });

test('judge tokens add every recorded judge call, or stay n/a, after measured judge tokens', () => {
  const call = total => ({ model: 'judge-model', seconds: 1, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: total } });
  assert.deepEqual(executionMeasurements({ evaluation: { judge_calls: [call(1200), call(800)] } }), { judge_tokens: 2000 });
  // One call without a usable total means no total: never a partial sum or 0.
  for (const judge_calls of [[call(1200), { model: 'judge-model', usage: null }], [call(1200), call(-1)], [call('800')], [call(1.5)], [],
    [call(Number.MAX_SAFE_INTEGER), call(1)], 'PRIVATE_FIXTURE']) {
    assert.equal(executionMeasurements({ evaluation: { judge_calls } }).judge_tokens, undefined);
  }
  // Producers that already measured judge tokens, such as Biomni, keep their value.
  assert.equal(executionMeasurements({ measurements: { judge_tokens: 5 }, evaluation: { judge_calls: [call(2000)] } }).judge_tokens, 5);
  assert.equal(executionMeasurements({ judge_usage: { totals: { totalTokens: 7 } }, evaluation: { judge_calls: [call(2000)] } }).judge_tokens, 7);
  assert.equal(executionMeasurements({ execution_metrics: { judge_tokens: 9 }, evaluation: { judge_calls: [call(2000)] } }).judge_tokens, 9);
});

test('reported Session usage fills generated and total tokens; an unreported call leaves both n/a, never 0', () => {
  // DRB-58 recorded one model invocation that produced 70006 output tokens.
  const drb58 = usageSummary([reported(20000, 70006)]);
  assert.deepEqual(sessionUsageTokens(drb58), { generation_output_tokens: 70006, total_tokens: 90006 });
  assert.deepEqual(sessionUsageTokens(usageSummary([reported(10, 5), reported(20, 7)])), { generation_output_tokens: 12, total_tokens: 42 });
  for (const summary of [usageSummary([reported(20000, 70006), unreported]), usageSummary([{ ...reported(1, 1), totalTokens: null }]),
    usageSummary([{ ...reported(1, 1), inputTokens: -1 }]), usageSummary([]), { totals: { invocationCount: 2 }, invocations: [reported(1, 1)] },
    null, { totals: { outputTokens: 5, totalTokens: 6 } }]) {
    assert.deepEqual(sessionUsageTokens(summary), {});
  }
  // The summary's own bucket totals add reported calls only; they must not leak through.
  const partial = { ...usageSummary([reported(20000, 70006), unreported]), totals: { invocationCount: 2, outputTokens: 70006, totalTokens: 90006 } };
  assert.deepEqual(executionMeasurements({ generation_usage: partial }), {});
  assert.deepEqual(executionMeasurements({ usage: partial, measurements: { tool_calls: 0 } }), { tool_calls: 0 });
  assert.deepEqual(executionMeasurements({ generation_usage: drb58 }), { generated_tokens: 70006, total_tokens: 90006 });
  assert.deepEqual([compactTokens(executionMeasurements({ generation_usage: partial }).generated_tokens), compactTokens(70006)], ['n/a', '70.0K']);
});

// A fake authenticated API: one Session `s` with its runs, subagents and evolve runs.
function sessionApi({ usage = usageSummary([reported(100, 40)]), runs = [{ id: 'r1' }], children = [], events = {}, streams = {}, evolve = {} } = {}) {
  const routes = new Map([['/api/sessions/s/usage', usage], ['/api/sessions/s/runs', runs], ['/api/sessions/s/subagents', children]]);
  for (const [run, records] of Object.entries(events)) routes.set(`/api/sessions/s/runs/${run}/events`, records);
  for (const [key, records] of Object.entries(streams)) {
    const [run, child] = key.split('/');
    routes.set(`/api/sessions/s/runs/${run}/streams/subagent-${child}/events`, records);
  }
  for (const [id, records] of Object.entries(evolve)) routes.set(`/api/evolve/runs/${id}/events`, records);
  return path => {
    if (!routes.has(path) || routes.get(path) === undefined) return Promise.reject(new Error(`GET ${path}: HTTP 404`));
    return Promise.resolve(structuredClone(routes.get(path)));
  };
}
const record = event => ({ sequence: 1, createdAt: '2026-01-01T00:00:00Z', runId: 'r1', sessionId: 's', event });
const tool = (type, id) => record({ type, trace: { id, name: 'run_shell', input: privateText, output: privateText, status: 'completed' } });
const step = (id, status = 'completed') => record({ type: 'subagent.step', subagentId: 'c1',
  step: { id: `${id}-${status}`, kind: 'tool', toolCallId: id, toolName: 'read_file', content: privateText, status } });

test('tool calls count distinct run, subagent and evolve call ids; an empty read is 0; truncated or missing is n/a without failing', async () => {
  const full = {
    runs: [{ id: 'r1' }, { id: 'r2' }],
    children: [{ id: 'c1', steps: [{ kind: 'assistant', content: privateText }, { kind: 'tool', toolCallId: 't3' }] }],
    events: { r1: [tool('tool.started', 't1'), tool('tool.completed', 't1'), tool('tool.started', 't2'), record({ type: 'run.completed' })],
      r2: [tool('tool.completed', 't1'), record({ type: 'assistant.delta', delta: privateText })] },
    streams: { 'r1/c1': [step('t3', 'running'), step('t3')], 'r2/c1': [] },
    evolve: { e1: [record({ type: 'search_started' }), record({ type: 'cost', cents: 1, tokens: 99 })] },
  };
  const measured = await collectCaseMeasurements(sessionApi(full), 's', { evolveRunIds: ['e1'] });
  assert.deepEqual(measured, { generation_output_tokens: 40, total_tokens: 140, tool_calls: 3 });
  assert.doesNotMatch(JSON.stringify(measured), /PRIVATE_FIXTURE/);
  assert.equal((await collectCaseMeasurements(sessionApi({ events: { r1: [record({ type: 'run.completed' })] } }), 's')).tool_calls, 0);
  // Each case below is unknown, not zero, and none of them rejects.
  const unknown = {
    truncated: { events: { r1: [tool('tool.started', 't1'), record({ type: 'run.history.truncated', droppedEvents: 3 })] } },
    'missing run events': { events: {} },
    'missing subagent stream': { ...full, streams: { 'r1/c1': full.streams['r1/c1'] } },
    'catalog tool step absent from the streams': { ...full, children: [{ id: 'c1', steps: [{ kind: 'tool', toolCallId: 't9' }] }] },
    'tool event without identity': { events: { r1: [record({ type: 'tool.started', trace: { name: 'run_shell' } })] } },
    'missing evolve events': { ...full, evolve: {} },
    'no run': { runs: [], events: {} },
  };
  for (const [name, fixture] of Object.entries(unknown)) {
    const result = await collectCaseMeasurements(sessionApi(fixture), 's', { evolveRunIds: fixture.evolve ? ['e1'] : [] });
    assert.equal(result.tool_calls, undefined, name);
    assert.deepEqual([result.generation_output_tokens, result.total_tokens], [40, 140], name);
  }
  const offline = await collectCaseMeasurements(() => { throw new Error(privateText); }, 's');
  assert.deepEqual(offline, {});
  assert.deepEqual(await collectCaseMeasurements(sessionApi({ usage: usageSummary([reported(1, 1), unreported]), events: { r1: [] } }), 's'), { tool_calls: 0 });
});

test('case-metrics.json identifies one plan entry; a second metrics document for a case clears its measurements', async t => {
  const source = 'test/journey-basic-real-api.spec.ts', file = 'journey-basic-real-api.spec.ts';
  const titles = ['L3-response: Short response and stream completion', 'L3-tool: A real command result reaches the final answer', 'L3-cancel: Cancel a live run and continue the session'];
  const basic = titles.map(title => ({ id: `playwright:${source}::real/${file}/${encodeURIComponent(title)}`, source, sourceHash: 'b'.repeat(64),
    runner: 'playwright', tags: ['category:e2e', 'model:real', 'os:linux', 'arch:amd64', 'tier:l3'] }));
  const full = createPlan([...basic, catalog[0]], { revision: 'candidate', profile: 'daily', targets: [{ os: 'linux', arch: 'amd64' }],
    execution: { backend: 'jiuwenswarm', model: 'generator', judge: 'judge' } });
  const plan = subplan(full, full.entries);
  const entries = basic.map(c => plan.entries.find(e => e.id === c.id)), drb = plan.entries.find(e => e.id === catalog[0].id);
  // The Playwright identity of the running test, exactly as the tagged reporter builds it.
  assert.deepEqual(caseIdentity({ source, project: 'real', titlePath: [file, titles[0]] }, plan.entries), { case: entries[0].id, key: entries[0].key });
  assert.deepEqual(caseIdentity({ source, project: 'real', titlePath: [titles[0]] }, plan.entries), { case: entries[0].id, key: entries[0].key });
  assert.deepEqual(caseIdentity({ source, project: 'real', titlePath: [file, titles[0]] }), { case: entries[0].id });

  const root = workspace(t), raw = join(root, 'raw');
  const caseMetrics = async (dir, title, api) => save(join(raw, '.ci-results/e2e-real/e2e/test-results', dir, 'case-metrics.json'), {
    schema_version: 1, ...caseIdentity({ source, project: 'real', titlePath: [file, title] }, plan.entries),
    measurements: await collectCaseMeasurements(api, 's'),
    prompt: privateText, answer: privateText, trace: privateText, error: privateText, api_key: privateText,
  });
  await caseMetrics('response', titles[0], sessionApi({ usage: usageSummary([reported(900, 100), reported(1500, 500)]),
    events: { r1: [tool('tool.started', 't1'), tool('tool.completed', 't1')] } }));
  await caseMetrics('tool', titles[1], sessionApi({ usage: usageSummary([reported(900, 100), unreported]),
    events: { r1: [record({ type: 'run.history.truncated', droppedEvents: 1 })] } }));
  // The published copy is the projection: identity and numbers only.
  await prepareRealE2EResults(raw);
  const staged = join(raw, '.tmp/real-e2e-results/e2e-real/e2e/test-results/response/case-metrics.json');
  const text = readFileSync(staged, 'utf8');
  assert.doesNotMatch(text, /PRIVATE_FIXTURE|measurements|invocations/);
  assert.deepEqual(JSON.parse(text), { schema_version: 1, case: entries[0].id, key: entries[0].key,
    execution_metrics: { generated_tokens: 600, total_tokens: 3000, tool_calls: 1 } });
  const basicResults = join(root, 'real-e2e-results-basic');
  const copy = dir => save(join(basicResults, dir, 'case-metrics.json'),
    JSON.parse(readFileSync(join(raw, '.tmp/real-e2e-results/e2e-real/e2e/test-results', dir, 'case-metrics.json'))));
  copy('response'); copy('tool');
  const verdict = verifyResults(plan, plan.entries.map(e => ({ key: e.key, outcome: 'PASS', actualTarget: e.target, actualBackend: e.backend })));
  const row = (id, summary = caseExecutionSummary(plan, root, verdict)) => summary.table.rows.find(r => r.case === id);
  const cells = r => [r.generated_tokens, r.judge_tokens, r.total_tokens, r.tool_calls, r.duration_min, r.peak_memory_gb, r.score];
  assert.deepEqual(cells(row(entries[0].id)), ['600', 'n/a', '3.0K', '1', 'n/a', 'n/a', 'n/a']);
  assert.deepEqual(cells(row(entries[1].id)), ['n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a']);
  assert.deepEqual(cells(row(entries[2].id)), Array(7).fill('n/a'));
  // Two documents for one case are ambiguous, so neither supplies a value.
  save(join(basicResults, 'response-copy/case-metrics.json'), JSON.parse(text));
  assert.deepEqual(cells(row(entries[0].id)), Array(7).fill('n/a'));
  // So a case with benchmark metrics must not also write case-metrics.json.
  const research = join(root, `real-e2e-results-${realShards(plan).find(s => s.keys.includes(drb.key)).name}`);
  save(join(research, 'drb/benchmark-metrics.json'), { case_id: 58, execution_metrics: { generated_tokens: 70006, tool_calls: 4 } });
  assert.equal(row('DRB-58').generated_tokens, '70.0K');
  save(join(research, 'drb/case-metrics.json'), { schema_version: 1, case: drb.id, key: drb.key, execution_metrics: { tool_calls: 4 } });
  assert.deepEqual([row('DRB-58').generated_tokens, row('DRB-58').tool_calls], ['n/a', 'n/a']);
});

test('the DRB projection publishes the judge-call total, not the judge ledger', async t => {
  const raw = workspace(t);
  const call = total => ({ model: 'PRIVATE_FIXTURE-judge-model', seconds: 2, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: total } });
  save(join(raw, '.ci-results/e2e-real/e2e/test-results/drb/benchmark-metrics.json'), {
    schema_version: 1, case_id: 58, prompt: privateText, generation_usage: usageSummary([reported(20000, 70006)]),
    measurements: { generation_output_tokens: 70006, total_tokens: 90006, tool_calls: 12 },
    evaluation: { status: 'completed', overall_score: 0.5, judges: { race: privateText }, judge_calls: [call(30000), call(12345)] },
  });
  await prepareRealE2EResults(raw);
  const text = readFileSync(join(raw, '.tmp/real-e2e-results/e2e-real/e2e/test-results/drb/benchmark-metrics.json'), 'utf8');
  assert.doesNotMatch(text, /PRIVATE_FIXTURE|judge_calls|judges|invocations/);
  const doc = JSON.parse(text);
  assert.deepEqual(doc.execution_metrics, { generated_tokens: 70006, judge_tokens: 42345, total_tokens: 90006, tool_calls: 12 });
  assert.deepEqual(doc.evaluation, { status: 'completed', overall_score: 0.5 });
});
