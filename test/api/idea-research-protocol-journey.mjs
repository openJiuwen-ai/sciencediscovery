// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** Actual public research entry -> authenticated Python sidecar -> run-pinned proxy -> native provider.
 * Run: node test/api/idea-research-protocol-journey.mjs
 * Requires built API and the repository's locked services/evolve/.venv (UT preparation supplies it).
 * Isolated API + real research sidecar only; no Runner, SDK, full stack, research content or paid calls.
 * Steps: start isolated services/auth controls; register each native model without probes; create research;
 * observe completed/scored persisted graph with unknown usage; verify token isolation and manual-only resume.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function runIdeaResearchProtocolJourney() {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const root = resolve('.tmp', `idea-research-protocol-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const secret = randomUUID(), internal = randomUUID(), providerKey = randomUUID();
  const children = [], steps = [], requests = [];
  let outcome = 'FAIL', origin, sidecarOrigin, gate;
  const redact = value => String(value).replaceAll(secret, '[redacted]').replaceAll(internal, '[redacted]').replaceAll(providerKey, '[redacted]');
  const until = async (fn, timeout = 20000) => { const end = Date.now() + timeout; for (;;) { const result = await fn(); if (result) return result; if (Date.now() > end) throw new Error('Timed out waiting for research result'); await new Promise(r => setTimeout(r, 30)); } };
  const start = async (command, args, env, pattern, name) => {
    const child = spawn(command, args, { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { child, name, log: '', url: '' }; children.push(state);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { state.log += redact(b); state.url ||= b.toString().match(pattern)?.[1] ?? ''; });
    await until(() => { if (child.exitCode !== null) throw new Error(`${name} exited: ${state.log}`); return state.url; });
    return state.url;
  };
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const body = JSON.parse(raw), protocol = req.url === '/v1/messages' ? 'anthropic-messages' : req.url === '/v1/responses' ? 'openai-responses' : 'openai-chat-completions';
    assert.equal(req.headers[protocol === 'anthropic-messages' ? 'x-api-key' : 'authorization'], protocol === 'anthropic-messages' ? providerKey : `Bearer ${providerKey}`);
    requests.push({ protocol, path: req.url, model: body.model });
    if (gate) { const held = gate; gate = undefined; await held; }
    const system = protocol === 'anthropic-messages' ? body.system : protocol === 'openai-responses' ? body.instructions : body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const value = system.includes('matching: {"candidates"') ? { candidates: [{ parentId: 'ROOT', hypothesis: 'Synthetic hypothesis' }], reason: 'One bounded synthetic comparison' }
      : system.includes('"score":1.0') ? { text: 'Synthetic independent assessment', score: 8 }
      : system.includes('"strengths":[]') ? { text: 'Synthetic aggregation', strengths: [], failureModes: [], uncertainties: [], evidenceGaps: [], recommendedNextMoves: [], constraintFlags: [], confidence: 0.5 }
      : { text: 'Synthetic design or propagation' };
    const text = JSON.stringify(value);
    const reply = protocol === 'anthropic-messages' ? { type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }
      : protocol === 'openai-responses' ? { object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }
      : { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
  const step = async (name, expected, work) => { try { const actual = await work(); steps.push({ name, expected, actual, status: 'PASS' }); } catch (e) { steps.push({ name, expected, actual: redact(e.stack), status: 'FAIL' }); throw e; } };
  let api;
  try {
    await step('1. Start owned API and real research sidecar', 'Healthy isolated services, internal/public auth enforced, no model requests', async () => {
      sidecarOrigin = await start(resolve('services/evolve/.venv/bin/python'), ['-m', 'uvicorn', 'sciencediscovery_evolve.server:app', '--host', '127.0.0.1', '--port', '0'], { SCIENCE_AGENT_DATA_DIR: resolve(root, 'sidecar'), SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN: internal, PYTHONPATH: resolve('services/evolve/src') }, /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/, 'sidecar');
      const portReservation = createServer();
      await new Promise(r => portReservation.listen(0, '127.0.0.1', r));
      const apiPort = portReservation.address().port;
      await new Promise(r => portReservation.close(r));
      origin = await start(process.execPath, ['services/api/dist/server.js'], { SCIENCE_AGENT_DATA_DIR: resolve(root, 'api'), SCIENCE_AGENT_AUTH_TOKEN: secret, SCIENCE_AGENT_HOST: '127.0.0.1', SCIENCE_AGENT_PORT: String(apiPort), SCIENCE_AGENT_EVOLVE_URL: sidecarOrigin, SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN: internal, SCIENCE_AGENT_RUNNER_URL: 'http://127.0.0.1:1', SCIENCE_AGENT_MEMORY_GRAPH_URL: 'http://127.0.0.1:1' }, /listening on (http:\/\/127\.0\.0\.1:\d+)/, 'api');
      api = async (path, body, method = body ? 'POST' : 'GET') => { const r = await fetch(origin + path, { method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) }); const text = await r.text(); assert.ok(!text.includes(providerKey) && !text.includes(internal)); return { status: r.status, body: JSON.parse(text) }; };
      assert.equal((await fetch(origin + '/api/models')).status, 401);
      assert.equal((await fetch(sidecarOrigin + '/idea-tree/research/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
      assert.deepEqual((await api('/api/models')).body, []); assert.equal(requests.length, 0);
      return 'Fresh model registry; public/internal unauthorized requests refused';
    });
    for (const apiProtocol of ['openai-chat-completions', 'openai-responses', 'anthropic-messages']) {
      let session, research;
      await step(`2. Register ${apiProtocol} without automatic calls`, 'Qualified saved native model, no provider probes', async () => {
        const before = requests.length;
        const model = await api('/api/models', { model: `synthetic-${apiProtocol}`, name: 'Synthetic research model', baseUrl: providerOrigin + '/v1', apiProtocol, apiToken: providerKey, proxyPolicy: 'none' }); assert.equal(model.status, 201);
        const project = await api('/api/projects', { name: 'Synthetic research' });
        session = (await api(`/api/projects/${project.body.id}/sessions`, { title: 'Synthetic native research', modelId: model.body.id })).body;
        assert.equal(requests.length, before); return 'Saved explicit protocol and token; zero probes';
      });
      await step(`3. Create and complete public ${apiProtocol} research`, 'Real Python stages finish with scored persisted graph and unknown billing', async () => {
        const before = requests.length;
        let release; gate = new Promise(r => { release = r; });
        const r = await api(`/api/sessions/${session.id}/idea-tree/research`, { content: '/idea-tree Synthetic bounded hypothesis comparison', settings: { explorationIntensity: 'quick', maxNodes: 2, maxDepth: 1, maxTokensPerCall: 256, maxTokens: 600000 } }); assert.equal(r.status, 200, JSON.stringify(r.body));
        research = r.body.research;
        await until(() => requests.length > before);
        // A session selection change cannot redirect an issued research grant.
        const other = await api('/api/models', { model: 'must-not-be-called', name: 'Different session selection', baseUrl: 'http://127.0.0.1:1/v1', apiProtocol, apiToken: 'synthetic-other' });
        try { assert.equal((await api(`/api/sessions/${session.id}`, { modelId: other.body.id }, 'PATCH')).status, 200); } finally { release(); }
        const view = await until(async () => { const r = await api(`/api/sessions/${session.id}/idea-tree/research`, { operation: 'get', researchId: research.id }); assert.equal(r.status, 200); return ['running', 'pausing'].includes(r.body.research.status) ? null : r.body; });
        assert.equal(view.research.status, 'completed', JSON.stringify(view.research)); assert.equal(view.research.usageKnown, false); assert.ok(view.research.unreportedBudgetEstimate > 0);
        const candidate = view.graph.nodes.find(n => n.kind === 'candidate'); assert.ok(candidate); assert.equal(candidate.score, 8); assert.equal(candidate.cycleComplete, true);
        assert.ok(requests.length - before >= 6); assert.ok(requests.slice(before).every(r => r.protocol === apiProtocol && r.model === `synthetic-${apiProtocol}`));
        const persisted = await api(`/api/sessions/${session.id}/idea-tree/research`); assert.equal(persisted.body.items[0].research.status, 'completed');
        const usage = await api(`/api/sessions/${session.id}/usage`); assert.equal(usage.status, 200); assert.ok(JSON.stringify(usage.body).includes('provider-not-reported')); assert.ok(!JSON.stringify(usage.body).includes('"costUsd":0'));
        return `Completed with scored persisted candidate; ${requests.length - before} selected native calls; usage/cost unknown`;
      });
      await step(`4. Check ${apiProtocol} research isolation and ended lifecycle`, 'API user token cannot buy run completions; completed research never auto-resumes', async () => {
        const before = requests.length;
        const denied = await api(`/internal/evolve-llm/${research.id}/v1/chat/completions`, { messages: [{ role: 'user', content: 'synthetic unauthorized' }] }); assert.equal(denied.status, 401);
        const resumed = await api(`/api/sessions/${session.id}/idea-tree/research`, { operation: 'continue', researchId: research.id }); assert.equal(resumed.status, 400); assert.match(resumed.body.error, /not resumable/);
        assert.equal(requests.length, before); return 'Run token boundary and manual lifecycle preserved';
      });
    }
    outcome = 'PASS';
  } finally {
    for (const { child } of [...children].reverse()) { child.kill('SIGTERM'); await until(() => child.exitCode !== null, 5000).catch(() => child.kill('SIGKILL')); }
    provider.closeAllConnections(); await new Promise(r => provider.close(r));
    for (const state of children) await writeFile(resolve(root, `${state.name}.log`), state.log);
    await writeFile(resolve(root, 'steps.json'), JSON.stringify({ sha, outcome, steps, requests, paidRequests: 0 }, null, 2));
    await writeFile(resolve(root, 'report.md'), `# Public IdeaTree native-family journey: ${outcome}\n\nSHA: ${sha}\nAPI: ${origin}\nSidecar: ${sidecarOrigin}\nNo Runner/full stack or paid providers.\n\n${steps.map(s => `- ${s.name}: ${s.status}\n  Expected: ${s.expected}\n  Actual: ${s.actual}`).join('\n')}\n`);
    console.log(JSON.stringify({ sha, outcome, report: resolve(root, 'report.md') }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runIdeaResearchProtocolJourney();
