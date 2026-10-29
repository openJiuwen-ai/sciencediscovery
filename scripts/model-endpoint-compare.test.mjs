// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createTest } from '../test/support/tagged/compat.mjs';
import { compareEndpoints, renderComparison } from './model-endpoint-compare.mjs';
const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'os:windows', 'os:macos', 'arch:amd64', 'arch:arm64'] });

const PROMPT = 'PRIVATE_FIXTURE prompt that must never leave the process';
const body = JSON.stringify({ model: 'shared-alias', stream: true, messages: [{ role: 'user', content: PROMPT }] });

async function stub(delayMs, { failEvery = 0 } = {}) {
  const received = [];
  let requests = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(Buffer.concat(chunks).toString('utf8'));
    requests += 1;
    if (failEvery && requests % failEvery === 0) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"provider busy"}}');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, received, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

test('comparison sends one identical body to both endpoints and reports latency separately', async () => {
  const fast = await stub(10);
  const slow = await stub(60);
  try {
    const report = await compareEndpoints({
      endpoints: [
        { name: 'direct', baseUrl: fast.baseUrl, model: 'shared-alias', token: 'SECRET-A' },
        { name: 'relay', baseUrl: slow.baseUrl, model: 'shared-alias', token: 'SECRET-B' },
      ],
      body, requests: 4, concurrency: 2, timeoutMs: 10_000,
    });
    assert.equal(report.scope, 'per_request_only');
    assert.equal(report.model, 'shared-alias');
    assert.equal(report.request_body.identical_for_both, true);
    assert.ok(report.observed_max_in_flight <= 2 && report.observed_max_in_flight >= 1);
    for (const endpoint of report.endpoints) {
      assert.equal(endpoint.attempted, 4);
      assert.equal(endpoint.completed, 4);
      assert.equal(endpoint.failed, 0);
      assert.equal(endpoint.tokens.total, 48);
      assert.equal(endpoint.tokens.complete, true);
      assert.equal(endpoint.finish_reasons.stop, 4);
      assert.ok(endpoint.elapsed_ms.p50 >= 20);
      assert.ok(endpoint.first_record_ms.p50 >= 10);
    }
    const direct = report.endpoints.find(endpoint => endpoint.name === 'direct');
    const relay = report.endpoints.find(endpoint => endpoint.name === 'relay');
    assert.ok(direct.elapsed_ms.p50 < relay.elapsed_ms.p50, 'the slower endpoint is visible in the per-request distribution');
    assert.deepEqual([...new Set(fast.received)].length, 1, 'every request from one endpoint carries the same body');
    assert.deepEqual(fast.received, slow.received, 'both endpoints receive byte-identical requests');
    const serialized = JSON.stringify(report);
    for (const secret of ['SECRET-A', 'SECRET-B', PROMPT, 'provider busy']) assert.ok(!serialized.includes(secret));
    const markdown = renderComparison(report);
    assert.match(markdown, /Per-request wire latency only/);
    assert.doesNotMatch(markdown, /SECRET|PRIVATE_FIXTURE/);
  } finally { await close(fast.server); await close(slow.server); }
});

test('comparison keeps provider failures out of completed latency and token counts', async () => {
  const flaky = await stub(5, { failEvery: 2 });
  const healthy = await stub(5);
  try {
    const report = await compareEndpoints({
      endpoints: [
        { name: 'flaky', baseUrl: flaky.baseUrl, model: 'shared-alias' },
        { name: 'healthy', baseUrl: healthy.baseUrl, model: 'shared-alias' },
      ],
      body, requests: 4, concurrency: 1, timeoutMs: 10_000,
    });
    const failed = report.endpoints.find(endpoint => endpoint.name === 'flaky');
    assert.equal(failed.attempted, 4);
    assert.equal(failed.failed, 2);
    assert.equal(failed.provider_failures, 2);
    assert.equal(failed.tokens.complete, false);
    assert.equal(failed.tokens.total, 24);
    const good = report.endpoints.find(endpoint => endpoint.name === 'healthy');
    assert.equal(good.failed, 0);
  } finally { await close(flaky.server); await close(healthy.server); }
});

test('comparison refuses differing model aliases so request bodies cannot silently differ', async () => {
  await assert.rejects(compareEndpoints({
    endpoints: [{ name: 'a', baseUrl: 'http://127.0.0.1:1', model: 'model-a' }, { name: 'b', baseUrl: 'http://127.0.0.1:2', model: 'model-b' }],
    body, requests: 1, concurrency: 1,
  }), /same model alias/);
});
