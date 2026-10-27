// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTest } from '../test/support/tagged/compat.mjs';
import { createPlan, subplan, verifyResults } from '../test/support/tagged/plan.mjs';
import { prepareRealE2EResults } from './prepare-real-e2e-results.mjs';
import { profiles } from '../test/support/tagged/profiles.mjs';
import { biomniCase, realShards } from '../test/support/tagged/execution.mjs';
import { dataset, manifestHash, evaluateSuite, projectMetrics, validateMetrics } from './biomni-gate.mjs';
import { generationTokens, judgeTokens, toolMetrics, settled, selectedProcesses, MEASUREMENT_VERSION } from '../test/benchmarks/biomnibench-da/metrics.mjs';
const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64', 'arch:arm64'] });
const catalog = dataset.tasks.map(t => ({ id: `playwright:test/biomnibench-da-swarm.spec.ts::BiomniBench-${t.id}%20analysis`,
  source: 'test/biomnibench-da-swarm.spec.ts', sourceHash: 'a'.repeat(64), runner: 'playwright',
  tags: ['category:e2e','model:real','judge:llm','os:linux','arch:amd64','tier:l5','status:external'] }));
const plan = { ...createPlan(catalog, { revision: 'candidate', profile: 'release', selector: profiles.release.selector,
  targets: [{ os: 'linux', arch: 'amd64' }], execution: { backend: 'jiuwenswarm', model: 'generator', judge: 'judge' } }), evaluatorRevision: 'evaluator' };
const policy = { mode: 'candidate', baseline: null, score_drop_points: 0, resource_increase_ratio: 0 };
const documents = () => plan.entries.map(e => ({ schema_version: 2, benchmark: 'biomnibench-da', case_id: biomniCase(e), key: e.key, revision: plan.revision,
  integration_status: 'passed', evaluation: { status: 'scored', score: 80, gating: true },
  identity: { dataset_revision: dataset.revision, manifest_sha256: manifestHash, evaluator_revision: plan.evaluatorRevision,
    measurement_version: MEASUREMENT_VERSION, generator_model: 'generator', judge_model: 'judge', backend: 'jiuwenswarm',
    run_budget_ms: 1000, workspace_budget_bytes: 40 * 1024 ** 3,
    machine: { os: 'linux', arch: 'x64', cpu: 'cpu', cores: 8, memory_bytes: 64000, kernel: 'kernel', node: 'v22' } },
  measurements: { score: 80, tool_calls: 12, tool_rounds: 5, peak_rss_bytes: 10000, e2e_ms: 1000, generation_tokens: 100,
    judge_tokens: 20, total_tokens: 120, generation_input_tokens: 80, generation_output_tokens: 20,
    judge_input_tokens: 15, judge_output_tokens: 5, judge_ms: 100, memory_samples: 2, memory_interval_ms: 1000, memory_scope: 'isolated-local-worker-rss-sum' } }));

test('all 50 public cases are L5-only, partitioned exactly once', () => {
  assert.equal(catalog.length, 50);
  for (const profile of ['pr','merge','daily']) assert.throws(() => createPlan(catalog, { revision: 'test', targets: [{os:'linux',arch:'amd64'}], selector: profiles[profile].selector }), /EMPTY_SELECTION/);
  assert.equal(realShards(plan).length, 50);
  assert.equal(new Set(realShards(plan).flatMap(s => s.keys)).size, 50);
});

test('Biomni workers receive the 40 GiB workspace and three-hour run budgets', () => {
  const workflow = readFileSync(new URL('../.github/workflows/real-e2e.yml', import.meta.url), 'utf8');
  assert.match(workflow, /SCIENCE_AGENT_MAX_WORKSPACE_BYTES:.*'42949672960'/);
  assert.match(workflow, /E2E_BIOMNI_RUN_TIMEOUT_MS:.*'10800000'/);
  const journey = readFileSync(new URL('../test/biomnibench-da-swarm.spec.ts', import.meta.url), 'utf8');
  assert.match(journey, /E2E_BIOMNI_RUN_TIMEOUT_MS", 10_800_000/);
  assert.match(journey, /SCIENCE_AGENT_MAX_WORKSPACE_BYTES", 40 \* 1024 \*\* 3/);
});

test('complete evidence creates an unapproved candidate, including a valid zero score', () => {
  const docs = documents(); docs[0].measurements.score = 0; docs[0].evaluation.score = 0;
  const result = evaluateSuite(plan, docs, policy);
  assert.equal(result.status, 'baseline_candidate');
  assert.equal(result.non_regression_certified, false);
  assert.equal(result.measured, 50); assert.equal(result.summary.min_score, 0);
});

test('missing, duplicate, foreign, incomplete and non-finite metrics fail closed', () => {
  for (const mutate of [d => d.pop(), d => d.push(d[0]), d => d[0].case_id = 'foreign', d => delete d[0].measurements,
    d => d[0].measurements.peak_rss_bytes = null, d => d[0].measurements.e2e_ms = Infinity, d => d[0].evaluation.status = 'error',
    d => d[0].evaluation.gating = false, d => d[0].measurements.total_tokens++, d => d[0].revision = 'other',
    d => d[0].identity.evaluator_revision = 'other', d => d[0].identity.generator_model = 'other',
    d => delete d[0].identity.workspace_budget_bytes]) {
    const docs = documents(); mutate(docs); assert.equal(evaluateSuite(plan, docs, policy).status, 'failed');
  }
  assert.equal(evaluateSuite({ ...plan, entries: plan.entries.slice(1) }, documents().slice(1), policy).status, 'failed');
});

test('comparison requires approval, compatible configuration, per-task score and resource bounds', () => {
  const baseline = { ...evaluateSuite(plan, documents(), policy), status: 'approved', approved_by: 'maintainer', approved_at: '2026-10-13' };
  const compare = { ...policy, mode: 'compare', baseline: 'approved.json' };
  assert.equal(evaluateSuite(plan, documents(), compare, baseline).non_regression_certified, true);
  for (const field of ['tool_calls','tool_rounds','peak_rss_bytes','e2e_ms','generation_tokens','judge_tokens']) {
    const docs = documents(); docs[0].measurements[field]++;
    docs[0].measurements.total_tokens = docs[0].measurements.generation_tokens + docs[0].measurements.judge_tokens;
    assert.equal(evaluateSuite(plan, docs, compare, baseline).status, 'failed');
  }
  const lower = documents(); lower[0].measurements.score--; lower[0].evaluation.score--;
  assert.match(evaluateSuite(plan, lower, compare, baseline).problems.join(), /SCORE_REGRESSION/);
  const different = documents(); different[0].identity.machine.cpu = 'different';
  assert.match(evaluateSuite(plan, different, compare, baseline).problems.join(), /INCOMPARABLE/);
  assert.equal(evaluateSuite(plan, documents(), compare, {...baseline, status:'baseline_candidate'}).status, 'failed');
  assert.equal(evaluateSuite(plan, documents(), compare).status, 'failed');
  assert.equal(evaluateSuite(plan, documents(), {...compare, resource_increase_ratio:NaN}, baseline).status, 'failed');
});

test('score projection drops prompt, credential and judge narrative fields', () => {
  const doc = documents()[0]; doc.prompt = 'secret'; doc.identity.provider = { token: 'secret' };
  doc.evaluation.criteria = { reason: 'secret' }; doc.measurements.raw = 'secret';
  assert.doesNotMatch(JSON.stringify(projectMetrics(doc)), /secret|criteria|provider/);
});

test('tokens include all invocation attempts and judge retries without double counting totals', () => {
  const invocation = { id:'1', usageStatus:'reported', inputTokens:10, outputTokens:3, totalTokens:13 };
  assert.equal(generationTokens({invocations:[invocation,{...invocation,id:'2'}]},['1']).total,13);
  assert.throws(() => generationTokens({invocations:[{...invocation,totalTokens:null}]}), /UNREPORTED/);
  assert.throws(() => generationTokens({invocations:[invocation,invocation]}), /DUPLICATE/);
  const attempt = {usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}};
  assert.equal(judgeTokens([attempt,attempt]).total,24);
  const partial = judgeTokens([attempt,{usage:null}]);
  assert.equal(partial.total,12);
  assert.equal(partial.complete,false);
  assert.equal(partial.unknown_attempts,1);
  assert.equal(partial.reported_attempts,1);
  const docs = documents(); docs[0].judge_usage = partial;
  assert.match(evaluateSuite(plan,docs,policy).problems.join(),/UNREPORTED_JUDGE_TOKENS/);
});

test('tool rounds deduplicate lifecycle events, group parallel calls and include child streams', () => {
  const evidence = {agentId:'main',agentRunId:'r',turn:1};
  const record = (type,id,e=evidence) => ({event:{type,trace:{id},evidence:e}});
  const child = {event:{type:'subagent.step',step:{kind:'tool',toolCallId:'a'},evidence:{...evidence,agentId:'child'}}};
  assert.deepEqual(toolMetrics([record('tool.started','a'),record('tool.completed','a'),record('tool.started','b'),child]), {tool_calls:3,tool_rounds:2});
  assert.throws(() => toolMetrics([record('tool.started','a',{})]), /EVIDENCE/);
  assert.throws(() => toolMetrics([{event:{type:'run.history.truncated'}}]), /TRUNCATED/);
});

test('background executions, timers, children and queued wakes prevent early completion', () => {
  const done = {runs:[{status:'completed'}],children:[],activity:{executions:[],transfers:[],timers:[]}};
  assert.equal(settled(done),true);
  for (const kind of ['executions','transfers','timers']) assert.equal(settled({...done,activity:{...done.activity,[kind]:[{state:'pending'}]}}),false);
  assert.equal(settled({...done,children:[{status:'running'}]}),false);
  assert.equal(settled({...done,runs:[...done.runs,{status:'queued'}]}),false);
  assert.throws(() => settled({...done,activity:{}}), /INCOMPLETE/);
});

test('memory scope includes sandbox descendants but excludes unrelated host processes', () => {
  const rows = [{pid:10,ppid:1,matches:true},{pid:11,ppid:10,matches:false},{pid:12,ppid:11,matches:false},{pid:13,ppid:1,matches:false}];
  assert.deepEqual(selectedProcesses(rows).map(r=>r.pid),[10,11,12]);
});

test('Linux memory sampler records a positive measurement for an isolated worker process', () => {
  const script = `import { startMemorySampler } from './test/benchmarks/biomnibench-da/metrics.mjs';
    const sampler = await startMemorySampler(process.env.SCIENCE_DISCOVERY_DATA_DIR, 20);
    await new Promise(r => setTimeout(r, 50)); console.log(JSON.stringify(await sampler.stop()));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, SCIENCE_DISCOVERY_DATA_DIR: `/tmp/biomni-sampler-${process.pid}` }, encoding: 'utf8', timeout: 10000,
  }));
  assert.ok(result.peak_rss_bytes > 0); assert.ok(result.samples >= 2);
  assert.equal(result.scope, 'isolated-local-worker-rss-sum');
});

test('suite reports all missing workers even when no artifact directory exists', t => {
  const root = mkdtempSync(join(tmpdir(), 'biomni-no-artifacts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parentPath = join(root, 'plan.json');
  writeFileSync(parentPath, JSON.stringify(subplan(plan, plan.entries)));
  const resultRoot = join(root, 'missing-results');
  const report = fileURLToPath(new URL('./real-report.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [report, parentPath, resultRoot], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.doesNotMatch(run.stderr, /ENOENT/);
  const verdict = JSON.parse(readFileSync(join(resultRoot, 'verdict.json')));
  assert.equal(verdict.status, 'FAIL');
  assert.equal(verdict.planned, 50);
  assert.equal(verdict.executed, 0);
  assert.equal(verdict.problems.filter(p => p.includes('SHARD_EVIDENCE_MISSING')).length, 50);
  assert.equal(verdict.biomni.measured, 0);
  assert.ok(existsSync(join(resultRoot, 'biomni-gate.md')));
});

test('matrix, score packaging and suite accounting preserve all metrics and reject stale partial candidates', async t => {
  const root = mkdtempSync(join(tmpdir(), 'biomni-gate-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const parent = subplan(plan, plan.entries), parentPath = join(root,'plan.json');
  writeFileSync(parentPath,JSON.stringify(parent));
  const githubOutput=join(root,'matrix.txt');
  execFileSync(process.execPath,[fileURLToPath(new URL('./real-matrix.mjs',import.meta.url)),parentPath],{env:{...process.env,GITHUB_OUTPUT:githubOutput}});
  const matrix=JSON.parse(readFileSync(githubOutput,'utf8').trim().slice('matrix='.length));
  assert.equal(matrix.include.length,50);
  assert.deepEqual(matrix.include.map(e=>e.biomni_case).sort(),dataset.tasks.map(t=>t.id).sort());
  const docs=documents();
  for(const shard of realShards(parent)) {
    const worker=subplan(parent,parent.entries.filter(e=>shard.keys.includes(e.key)));
    const directory=join(root,`real-e2e-results-${shard.name}`,'e2e-real/tagged');mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,'plan.json'),JSON.stringify(worker));
    writeFileSync(join(directory,'summary.json'),JSON.stringify(verifyResults(worker,worker.entries.map(e=>({key:e.key,outcome:'PASS',actualTarget:e.target,actualBackend:e.backend})))));
    const doc=docs.find(d=>d.key===worker.entries[0].key);
    writeFileSync(join(directory,'../benchmark-metrics.json'),JSON.stringify(projectMetrics(doc)));
  }
  const report=fileURLToPath(new URL('./real-report.mjs',import.meta.url));
  const policyPath=join(root,'candidate-policy.json');writeFileSync(policyPath,JSON.stringify(policy));
  const run=()=>spawnSync(process.execPath,[report,parentPath,root,policyPath],{cwd:root,encoding:'utf8'});
  const first=run();assert.equal(first.status,0,first.stderr);
  const candidate=join(root,'biomni-baseline-candidate.json');
  assert.equal(JSON.parse(readFileSync(candidate)).cases.length,50);
  await prepareRealE2EResults(root);
  const projected=JSON.parse(readFileSync(join(root,'.tmp/real-e2e-results/research-1/e2e-real/benchmark-metrics.json')));
  assert.deepEqual(projected.measurements,docs[0].measurements);
  rmSync(join(root,'real-e2e-results-research-1/e2e-real/benchmark-metrics.json'));
  assert.equal(run().status,1);
  assert.equal(existsSync(candidate),false);
  assert.match(JSON.parse(readFileSync(join(root,'verdict.json'))).problems.join(),/MISSING_OR_DUPLICATE/);
});

// The frozen execution target must agree with the measured host architecture.
test('ARM64 metrics keep their actual architecture and reject a mismatched host', () => {
  const entry = { ...plan.entries[0], target: { os: 'linux', arch: 'arm64' } };
  const doc = documents()[0];
  doc.identity.machine.arch = 'arm64';
  assert.equal(validateMetrics(doc, entry, plan).identity.machine.arch, 'arm64');
  doc.identity.machine.arch = 'x64';
  assert.throws(() => validateMetrics(doc, entry, plan), /METRIC_CONFIGURATION/);
});

test('default release stays AMD64 and explicit ARM64 selects exactly fifty Biomni cases', () => {
  assert.deepEqual(profiles.release.targets, [{ os: 'linux', arch: 'amd64' }]);
  const portable = catalog.map(e => ({ ...e, tags: [...e.tags, 'arch:arm64'] }));
  const arm = createPlan(portable, { revision: 'candidate', profile: 'release',
    selector: profiles.release.selector, targets: [{ os: 'linux', arch: 'arm64' }],
    execution: { backend: 'jiuwenswarm', model: 'generator', judge: 'judge' } });
  assert.equal(arm.entries.length, 50);
  assert.ok(arm.entries.every(e => e.target.arch === 'arm64'));
});
