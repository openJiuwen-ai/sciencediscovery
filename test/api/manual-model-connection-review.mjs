// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** CFG-R14 public product journey. Run from the WSL deployment with a committed
 * candidate: E2E_BASE_URL=http://127.0.0.1:4420 E2E_AUTH_TOKEN=<local app token>
 * node test/api/manual-model-connection-review.mjs
 * Models and probes use ONLY this driver's loopback fixture and a synthetic key.
 * No commercial model, external wire, project, session or default change.
 * Existing model required; all owned model/provider IDs are removed in finally.
 * --fixture starts the same fixture on port 4568 for a real browser journey;
 * keep it alive during that journey and stop its exact process afterwards.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const key = 'synthetic-manual-connection-fixture';
const calls = [];
const fixture = createServer(async (request, response) => {
  if (request.url === '/audit') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(calls)); return;
  }
  const authorized = request.headers.authorization === `Bearer ${key}`;
  calls.push({ method: request.method, path: request.url, authorized });
  for await (const _ of request) { /* drain without logging content or credentials */ }
  response.setHeader('content-type', 'application/json');
  if (!authorized) { response.writeHead(401); response.end('{"error":"Fixture accepts synthetic credentials only"}'); return; }
  if (request.url === '/v1/models') response.end(JSON.stringify({ data: [{ id: 'manual-http-fixture' }] }));
  else if (request.url === '/v1/chat/completions') response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  else { response.writeHead(404); response.end('{}'); }
});
await new Promise(resolve => fixture.listen(process.argv.includes('--fixture') ? 4568 : 0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${fixture.address().port}/v1`;
if (process.argv.includes('--fixture')) {
  console.log(JSON.stringify({ fixture: baseUrl, credential: 'synthetic fixture only', pid: process.pid }));
} else {
  const origin = process.env.E2E_BASE_URL;
  const token = process.env.E2E_AUTH_TOKEN;
  let providerId, modelId;
  const steps = [];
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const expect = (label, result, status) => { assert.equal(result.status, status, `${label}: ${JSON.stringify(result.body)}`); steps.push({ label, status: 'PASS' }); return result.body; };
  let failure;
  try {
    assert.ok(origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin), 'Explicit local product origin required');
    assert.ok(token, 'Local product token required');
    assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), '', 'Committed candidate required');
    const existing = expect('Read existing models', await request('/api/models'), 200);
    assert.ok((existing.models ?? existing).length, 'Requires existing model so no default is claimed');
    const input = { name: 'CFG-R14 owned manual HTTP fixture', baseUrl, apiProtocol: 'openai-chat-completions', apiVariant: 'openai', modelDiscovery: 'openai-models', proxyPolicy: 'none', apiToken: key };
    const preview = expect('Fetch unsaved model list', await request('/api/providers/preview-models', 'POST', input), 200);
    assert.equal(preview.models[0].id, 'manual-http-fixture');
    const provider = expect('Save user-entered provider', await request('/api/providers', 'POST', input), 201);
    providerId = provider.id;
    const profile = expect('Register selected model without changing default', await request(`/api/providers/${providerId}/models`, 'POST', { model: 'manual-http-fixture', setGlobalDefault: false }), 201);
    modelId = profile.id;
    const expectedDestination = { baseUrl, profileUpdatedAt: profile.updatedAt };
    const tested = expect('Probe the saved HTTP gateway with the saved destination snapshot', await request(`/api/models/${modelId}/test`, 'POST', { consent: true, expectedDestination }), 200);
    assert.equal(tested.ok, true);
    const savedList = expect('Read saved model after successful connection', await request('/api/models'), 200);
    const stored = (savedList.models ?? savedList).find(model => model.id === modelId);
    assert.ok(stored, 'Successful connection must remain registered');
    assert.equal(stored.baseUrl.replace(/\/+$/, ''), baseUrl);
    assert.ok(calls.some(call => call.path === '/v1/models' && call.authorized));
    assert.ok(calls.some(call => call.path === '/v1/chat/completions' && call.authorized));
  } catch (error) { failure = error; }
  finally {
    if (modelId) expect('Remove exact owned model', await request(`/api/models/${modelId}`, 'DELETE'), 200);
    if (providerId) expect('Remove exact owned provider', await request(`/api/providers/${providerId}`, 'DELETE'), 200);
    await new Promise(resolve => fixture.close(resolve));
    const directory = `.tmp/manual-model-connection-${sha.slice(0, 8)}`;
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/report.md`, `# CFG-R14 manual model connection\n\nCandidate: ${sha}\n\nResult: ${failure ? 'FAIL' : 'PASS'}\n\nOnly loopback fixture and synthetic credential. No external calls.\n\n${steps.map((step, i) => `${i + 1}. ${step.label}: ${step.status}`).join('\n')}\n\n${failure ? String(failure) : 'All owned records cleaned.'}\n`);
    console.log(JSON.stringify({ sha, steps, calls, result: failure ? 'FAIL' : 'PASS', report: `${directory}/report.md` }));
  }
  if (failure) throw failure;
}
