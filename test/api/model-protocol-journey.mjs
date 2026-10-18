// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/**
 * E2E-META
 * Purpose: Consent to protocol checks, preserve manual selection, complete Agent turns with unknown usage.
 * Steps: Start isolated production API CLI; register loopback provider; refuse unconsented probe; check three families; update selection; create Session; submit and continue Agent turns; inspect results.
 * Environment: Built committed task worktree, ephemeral API-only process and .tmp data. Native backend explicitly selected by absence of Swarm config.
 * Type: mocked
 * LLM: journey-owned deterministic loopback three-protocol fixture, missing usage.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none; Runner/sidecars are not needed for text-only turns.
 * Credentials: random synthetic local credentials held in memory.
 * CostSideEffects: temporary local API process and records; no paid requests.
 * Run: node --import tsx test/api/model-protocol-journey.mjs
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_MODEL_API_VARIANT } from '../../packages/schema/dist/index.js';
import { protocolProvider } from '../helpers/protocol-provider.ts';
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), '', 'Commit candidate before E2E');
const root = resolve('.tmp', `model-protocol-journey-${randomUUID()}`);
await mkdir(root, { recursive: true });
const token = randomUUID();
const provider = await protocolProvider('all', { usage: 'missing' });
const steps = [];
let logs = '', origin, outcome = 'FAIL';
const redact = value => String(value).replaceAll(token, '[redacted]').replaceAll(process.cwd(), '<worktree>');
const child = spawn(process.execPath, ['services/api/dist/server.js'], { stdio: ['ignore', 'pipe', 'pipe'], env: {
  PATH: process.env.PATH, SCIENCE_AGENT_PORT: '0', SCIENCE_AGENT_HOST: '127.0.0.1', SCIENCE_DISCOVERY_DATA_DIR: resolve(root, 'data'),
  SCIENCE_AGENT_AUTH_TOKEN: token, SCIENCE_AGENT_RUNNER_URL: 'http://127.0.0.1:1', SCIENCE_AGENT_MODEL_CATALOG_PATH: resolve(root, 'absent-catalog'),
  SCIENTIFIC_ENVS: '0', SCIENCE_AGENT_NPU_BROKER: '0', SCIENCE_AGENT_MEMORY_GRAPH_URL: 'http://127.0.0.1:1', SCIENCE_AGENT_EVOLVE_URL: 'http://127.0.0.1:1',
} });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs += redact(chunk); const match = chunk.toString().match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (match) origin = match[1]; });
async function until(fn, ms = 15000) { const deadline = Date.now() + ms; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > deadline) throw new Error('Timed out awaiting observable result'); await new Promise(r => setTimeout(r, 40)); } }
async function request(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  const text = await response.text(); return { status: response.status, text, body: JSON.parse(text) };
}
async function step(name, expected, work) { try { const actual = await work(); steps.push({ name, expected, actual, status: 'PASS' }); } catch (error) { steps.push({ name, expected, actual: redact(error.stack), status: 'FAIL' }); throw error; } }
try {
  await step('1. Start isolated API CLI', 'Healthy API, explicit native backend, no full stack', async () => { await until(() => { if (child.exitCode !== null) throw new Error(logs); return origin; }); assert.equal((await fetch(`${origin}/health`)).status, 200); return `API healthy at ${origin}`; });
  for (const apiProtocol of ['openai-chat-completions', 'openai-responses', 'anthropic-messages']) {
    let model;
    await step(`2. Register ${apiProtocol} and refuse a check without consent`, 'No provider request before consent', async () => {
      model = (await request('/api/models', { name: `Synthetic ${apiProtocol}`, model: 'synthetic', baseUrl: provider.baseUrl, apiProtocol, apiToken: token, proxyPolicy: 'none' })).body;
      const before = provider.requests.length;
      assert.equal((await request(`/api/models/${model.id}/test`, {})).status, 400);
      assert.equal(provider.requests.length, before);
      return 'Saved selection; unconsented check refused locally';
    });
    await step(`3. Explicitly check ${apiProtocol}`, 'All three protocols report independent capabilities; usage unknown; saved choice unchanged', async () => {
      const result = await request(`/api/models/${model.id}/test`, { consent: true, compatibility: true });
      assert.equal(result.status, 200); assert.ok(result.body.protocols.every(p => p.basic.ok && p.streaming.ok && p.tools.ok && p.usage === 'unknown'));
      const saved = (await request('/api/models')).body.find(m => m.id === model.id); assert.equal(saved.apiProtocol, apiProtocol);
      const beforeOverride = provider.requests.length;
      const override = apiProtocol === 'openai-responses' ? 'openai-chat-completions' : 'openai-responses';
      assert.equal((await request(`/api/models/${model.id}`, { name: model.name, model: model.model, baseUrl: model.baseUrl, apiProtocol: override, apiVariant: DEFAULT_MODEL_API_VARIANT[override] }, 'PUT')).status, 200);
      assert.equal((await request('/api/models')).body.find(m => m.id === model.id).apiProtocol, override);
      assert.equal(provider.requests.length, beforeOverride, 'Saving a manual override must not automatically spend tokens');
      assert.equal((await request(`/api/models/${model.id}`, { name: model.name, model: model.model, baseUrl: model.baseUrl, apiProtocol, apiVariant: DEFAULT_MODEL_API_VARIANT[apiProtocol] }, 'PUT')).status, 200);

      assert.doesNotMatch(result.text, new RegExp(token));
      return 'Three protocol matrices pass; usage stays unknown; no protocol switch';
    });
    await step(`4. Complete and continue an Agent session using ${apiProtocol}`, 'Two successful Agent turns and accessible retained messages without usage', async () => {
      const project = (await request('/api/projects', { name: `Protocol ${apiProtocol}` })).body;
      const session = (await request(`/api/projects/${project.id}/sessions`, { title: 'Synthetic protocol journey', modelId: model.id, approvalMode: 'always_allow' })).body;
      for (let i = 0; i < 2; i++) {
        const response = await fetch(`${origin}/api/sessions/${session.id}/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: `Synthetic turn ${i}` }), signal: AbortSignal.timeout(20000) });
        assert.equal(response.status, 200); const stream = await response.text(); assert.match(stream, /"type":"run.completed"/); assert.doesNotMatch(stream, /"type":"run.failed"/);
      }
      const detail = await request(`/api/sessions/${session.id}`); assert.equal(detail.status, 200); assert.match(detail.text, /OK/);
      return 'Two Agent runs completed and visible reply retained';
    });
  }
  if (process.argv.includes('--browser')) await step('5. Browser consent and matrix journey', 'Consent, capability details and responsive layouts pass through the shipped UI', async () => {
    const browser = spawn('npm', ['run', 'test:mocked', '--', 'journey-model-compatibility.spec.ts', '--workers=1'], { cwd: resolve('.e2e'), env: { PATH: process.env.PATH, E2E_BASE_URL: origin, E2E_API_TOKEN: token, NODE_OPTIONS: '--max-old-space-size=768' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; for (const stream of [browser.stdout, browser.stderr]) stream.on('data', chunk => { output += redact(chunk); });
    const exit = await new Promise(r => browser.once('close', r)); await writeFile(resolve(root, 'browser.log'), output);
    assert.equal(exit, 0, output); return 'Pinned browser journey passed';
  });
  outcome = 'PASS';
} finally {
  await writeFile(resolve(root, 'report.md'), `# Model protocol API journey: ${outcome}\n\nSHA: ${sha}\n\n${steps.map(s => `- ${s.name}: ${s.status}\n  Expected: ${s.expected}\n  Actual: ${s.actual}`).join('\n')}\n`);
  await writeFile(resolve(root, 'steps.json'), JSON.stringify({ sha, outcome, steps }, null, 2));
  await writeFile(resolve(root, 'api.log'), logs);
  child.kill('SIGTERM'); await until(() => child.exitCode !== null, 20000).catch(() => child.kill('SIGKILL'));
  await provider.close(); await rm(resolve(root, 'data'), { recursive: true, force: true });
  console.log(JSON.stringify({ sha, outcome, report: resolve(root, 'report.md') }));
}
