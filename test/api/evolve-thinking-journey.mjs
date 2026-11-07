// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

/**
 * E2E-META
 * Purpose: Launch background searches from an enabled/low Run, recover HTTP 524,
 * preserve capped-empty accounting, stop an active stream and start again.
 * Steps: Start isolated built API and source Evolve sidecar; register local model;
 * submit Agent turns; inspect frozen goals, events and published artifacts;
 * cancel a held mutation; verify a subsequent search succeeds.
 * Environment: Linux with working bubblewrap; committed/built task worktree.
 * Type: mocked
 * LLM: journey-owned deterministic loopback SSE model (DeepSeek wire format).
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: real local Evolve engines and sandbox; no external services.
 * Credentials: random synthetic local credentials only.
 * CostSideEffects: isolated temporary data/processes; no paid requests.
 * Run: node test/api/evolve-thinking-journey.mjs [path-to-evolve-python]
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function runEvolveThinkingJourney({ pythonExecutable } = {}) {
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot, encoding: 'utf8' }).trim(), '', 'Commit candidate before E2E');
assert.equal(process.platform, 'linux', 'BLOCKED: Linux with working bubblewrap required');
const python = resolve(repoRoot, pythonExecutable ?? 'services/evolve/.venv/bin/python');
const root = resolve(repoRoot, '.tmp', `evolve-thinking-${randomUUID()}`), data = resolve(root, 'data');
await mkdir(root, { recursive: true });
const token = randomUUID(), internal = randomUUID(), providerKey = randomUUID();
const children = [], steps = [], requests = [];
let origin, model, project, scenario, outcome = 'FAIL', providerFailure;
const redact = value => String(value).replaceAll(token, '[redacted]').replaceAll(internal, '[redacted]').replaceAll(providerKey, '[redacted]');
async function until(check, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (providerFailure) throw providerFailure;
    const result = await check(); if (result) return result;
    if (Date.now() >= end) throw new Error('Timed out waiting for product outcome');
    await new Promise(done => setTimeout(done, 40));
  }
}
async function start(command, args, env, pattern, name) {
  const child = spawn(command, args, { cwd: repoRoot, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, name, log: '', url: '', error: null, closed: false }; children.push(state);
  child.on('error', error => { state.error = error; });
  child.on('close', () => { state.closed = true; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { state.log += redact(chunk); state.url ||= chunk.toString().match(pattern)?.[1] ?? ''; });
  return until(() => {
    if (state.error || child.exitCode !== null) throw new Error(`${name} unavailable: ${state.error ?? state.log}`);
    return state.url;
  }, 120000);
}
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
  const text = await response.text(); assert.ok(response.ok, `${path}: ${response.status} ${text}`);
  return JSON.parse(text);
}
async function step(name, expected, work) {
  try { steps.push({ name, expected, actual: await work(), status: 'PASS' }); console.log(`${name}: PASS`); }
  catch (error) { steps.push({ name, expected, actual: redact(error.stack), status: 'FAIL' }); throw error; }
}
const evaluatorSource = `import os, json, traceback
shards = os.environ['SCIENCE_AGENT_SHARDS'].split(',')
try:
    import candidate
    scores = [float(candidate.solve(int(shard))) for shard in shards]
    result = {'valid': True, 'metrics': {'score': sum(scores) / len(scores)}, 'error': ''}
except Exception:
    result = {'valid': False, 'metrics': {'score': 0}, 'error': traceback.format_exc()}
with open(os.environ['SCIENCE_AGENT_RESULT'], 'w') as output:
    json.dump(result, output)
`;
function sse(response, delta, finish = 'stop', completion = 20) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: completion, total_tokens: completion + 10 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}
const provider = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(request.headers.authorization, `Bearer ${providerKey}`);
    assert.equal(body.stream, true);
    assert.equal(body.reasoning_effort, 'low');
    assert.deepEqual(body.thinking, { type: 'enabled' });
    const main = Boolean(body.tools?.length);
    requests.push({ scenario: scenario.name, main, effort: body.reasoning_effort, streaming: body.stream });
    if (main) {
      const lastUser = body.messages.findLastIndex(m => m.role === 'user');
      const history = body.messages.slice(lastUser + 1);
      const results = history.filter(m => m.role === 'tool');
      assert.ok(!JSON.stringify(results).includes('refusedBecause'), JSON.stringify(results));
      const call = results.length === 0 ? { name: 'get_evolve_budget', arguments: {} }
        : results.length === 1 ? { name: 'create_evolve_run', arguments: {
          algorithm: scenario.algorithm, mode: 'custom_script', statement: 'Improve deterministic bounded score',
          howScored: 'Mean solve value on held-out cases', startingPointText: 'def solve(case):\n    return 0.4\n',
          evaluatorSource, split: { gateShards: 8, rolloutShards: 4, testShards: 2, seed: 0, shardRows: 1, trainRows: null },
          expansions: 4, workers: 1,
        } } : undefined;
      if (results.length === 1) assert.match(JSON.stringify(results), /low/);
      sse(response, call ? { role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
        : { role: 'assistant', content: 'Background search submitted.' }, call ? 'tool_calls' : 'stop');
      return;
    }
    scenario.calls++;
    if (scenario.kind === 'retry' && scenario.calls === 1) { response.writeHead(524).end('Synthetic gateway timeout'); return; }
    if (scenario.kind === 'cancel') {
      const current = scenario;
      response.on('close', () => { current.closed = true; });
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
      response.write(': waiting for a candidate\n\n'); return;
    }
    if (scenario.kind === 'capped') { sse(response, { role: 'assistant', content: '' }, 'length', body.max_tokens); return; }
    sse(response, { role: 'assistant', content: `\`\`\`python\n"""Improved candidate ${scenario.calls}."""\ndef solve(case):\n    return ${0.5 + scenario.calls / 100}\n\`\`\`` });
  } catch (error) { providerFailure = error; response.writeHead(500).end(redact(error.stack)); }
});
await new Promise(done => provider.listen(0, '127.0.0.1', done));
async function submit(current) {
  scenario = current;
  const created = await api(`/api/projects/${project.id}/sessions`, { title: current.name });
  const session = await api(`/api/sessions/${created.id}`, { modelId: model.id,
    thinkingMode: 'enabled', thinkingEffort: 'low', enabledConnectorIds: [], enabledSkillIds: [], semanticReviewEnabled: false }, 'PATCH');
  await api(`/api/sessions/${session.id}`, { approvalMode: 'always_allow' }, 'PATCH');
  await api(`/api/sessions/${session.id}/reviewer-specialist/settings`, { automaticReviewEnabled: false, level: 'quick' }, 'PUT');
  const response = await fetch(`${origin}/api/sessions/${session.id}/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: `Start ${current.algorithm} background search ${current.name}.` }), signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200); const stream = await response.text();
  if (providerFailure) throw providerFailure;
  assert.match(stream, /"type":"run.completed"/); assert.doesNotMatch(stream, /"type":"run.failed"/);
  const run = await until(async () => (await api(`/api/evolve/runs?sessionId=${session.id}`))[0]);
  assert.equal(run.goal.thinking, 'enabled'); assert.equal(run.goal.thinkingEffort, 'low');
  assert.equal(run.goal.budget.maxTokensPerCall, current.algorithm === 'puct' ? 96000 : 128000);
  return { session, run };
}
async function settled(session) {
  return until(async () => { const run = (await api(`/api/evolve/runs?sessionId=${session.id}`))[0]; return !run || ['pending', 'running'].includes(run.status) ? null : run; }, 60000);
}
try {
  await step('1. Start isolated services and select low effort', 'Healthy API and source sidecar; model high default, session low override; no external calls', async () => {
    const sidecar = await start(python, ['-m', 'uvicorn', 'sciencediscovery_evolve.server:app', '--host', '127.0.0.1', '--port', '0'], { SCIENCE_AGENT_DATA_DIR: data, SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN: internal }, /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/, 'sidecar');
    assert.equal((await fetch(sidecar + '/health')).status, 200);
    const reservation = createServer(); await new Promise(done => reservation.listen(0, '127.0.0.1', done));
    const port = reservation.address().port; await new Promise(done => reservation.close(done));
    origin = await start(process.execPath, [resolve(repoRoot, 'services/api/dist/server.js')], { SCIENCE_AGENT_DATA_DIR: data, SCIENCE_AGENT_AUTH_TOKEN: token,
      SCIENCE_AGENT_PORT: String(port), SCIENCE_AGENT_HOST: '127.0.0.1', SCIENCE_AGENT_EVOLVE_URL: sidecar, SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN: internal,
      SCIENCE_AGENT_RUNNER_URL: 'http://127.0.0.1:1', SCIENCE_AGENT_MEMORY_GRAPH_URL: 'http://127.0.0.1:1', SCIENCE_AGENT_SAMPLE_SESSION: '0',
      SCIENCE_AGENT_MODEL_CATALOG_PATH: resolve(root, 'absent-catalog'), SCIENCE_AGENT_USAGE_EXCHANGE_RATES_ENABLED: '0', SCIENTIFIC_ENVS: '0',
    }, /listening on (http:\/\/127\.0\.0\.1:\d+)/, 'api');
    assert.equal((await fetch(origin + '/health')).status, 200);
    model = await api('/api/models', { name: 'Synthetic DeepSeek', model: 'synthetic', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiProtocol: 'openai-chat-completions', apiVariant: 'deepseek', apiToken: providerKey, proxyPolicy: 'none', thinkingMode: 'enabled', thinkingEffort: 'high' });
    project = await api('/api/projects', { name: 'Evolution thinking journey' });
    return 'Owned services healthy; local provider saved without calls';
  });
  for (const algorithm of ['puct', 'openevolve']) await step(`2. Complete ${algorithm} after HTTP 524`, 'Low reaches upstream; one retry; persisted scored search and winner artifact', async () => {
    const current = { name: algorithm + '-retry', algorithm, kind: 'retry', calls: 0 };
    const { session } = await submit(current); const done = await settled(session);
    assert.equal(done.status, 'succeeded', JSON.stringify(done)); assert.equal(current.calls, 5);
    const events = await api(`/api/evolve/runs/${done.id}/events`); assert.ok(events.some(record => record.event.type === 'expanded' && record.event.valid));
    const versions = await until(async () => {
      const artifacts = await api(`/api/sessions/${session.id}/artifacts`);
      for (const artifact of artifacts.filter(item => item.originMeta?.evolveRunId === done.id)) {
        const list = await api(`/api/sessions/${session.id}/artifacts/${artifact.id}/versions`);
        if (list.length >= 2) return list;
      }
      return null;
    });
    return `${done.id}: succeeded, 4 candidates/5 requests, published ${versions.length} artifact versions`;
  });
  await step('3. Preserve capped-empty accounting without duplicate calls', 'Four empty expansions fail; exactly four charged requests', async () => {
    const current = { name: 'capped', algorithm: 'openevolve', kind: 'capped', calls: 0 };
    const { session } = await submit(current); const done = await settled(session);
    assert.equal(done.status, 'failed', JSON.stringify(done)); assert.equal(current.calls, 4);
    const events = await api(`/api/evolve/runs/${done.id}/events`); assert.match(JSON.stringify(events), /hidden thinking/);
    assert.equal(done.tokens, 4 * (128000 + 10));
    return `${done.id}: failed with capped-thinking explanation; ${done.tokens} tokens, no repeated empty completion`;
  });
  await step('4. Stop an active model stream and recover', 'Public stop cancels upstream and settles stopped; fresh search succeeds', async () => {
    const current = { name: 'cancel', algorithm: 'puct', kind: 'cancel', calls: 0, closed: false };
    const { session, run } = await submit(current); await until(() => current.calls > 0);
    await api(`/api/evolve/runs/${run.id}/stop`, {}); const done = await settled(session);
    assert.equal(done.status, 'stopped', JSON.stringify(done)); await until(() => current.closed); assert.equal(current.calls, 1);
    const recovery = { name: 'recovery', algorithm: 'puct', kind: 'success', calls: 0 };
    const next = await submit(recovery); assert.equal((await settled(next.session)).status, 'succeeded'); assert.equal(recovery.calls, 4);
    return 'Active upstream disconnected; no retry after stop; subsequent search completed';
  });
  outcome = 'PASS';
} finally {
  for (const state of children.reverse()) {
    state.child.kill('SIGTERM');
    const end = Date.now() + 5000;
    while (!state.closed && Date.now() < end) await new Promise(done => setTimeout(done, 40));
    if (!state.closed) state.child.kill('SIGKILL');
    await writeFile(resolve(root, `${state.name}.log`), state.log);
  }
  provider.closeAllConnections(); await new Promise(done => provider.close(done));
  await writeFile(resolve(root, 'report.md'), `# Evolution thinking API journey: ${outcome}\n\nSHA: ${sha}\nWorktree: ${repoRoot}\nDriver: node test/api/evolve-thinking-journey.mjs ${python}\n\n${steps.map(s => `${s.name}: ${s.status}\nExpected: ${s.expected}\nActual: ${s.actual}\n`).join('\n')}`);
  await writeFile(resolve(root, 'steps.json'), JSON.stringify({ sha, outcome, steps, requests }, null, 2));
  await rm(data, { recursive: true, force: true });
  console.log(JSON.stringify({ sha, outcome, report: resolve(root, 'report.md') }));
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runEvolveThinkingJourney({ pythonExecutable: process.argv[2] });
}
