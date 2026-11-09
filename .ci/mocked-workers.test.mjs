// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createTest } from '../test/support/tagged/compat.mjs';
import { mockedWorkers, reserveMockedPorts, runMockedBatches } from '../test/support/tagged/mocked-workers.mjs';
const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });
const batch = (key, fresh = false) => ({ key, entries: [{ tags: fresh ? ['isolation:fresh'] : ['isolation:global'] }] });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('fresh-library execution finishes before independent global stacks overlap', async () => {
  const fresh = gate(), bothStarted = gate(), release = gate();
  const started = [];
  let active = 0, peak = 0;
  const pending = runMockedBatches([batch('global-a'), batch('fresh', true), batch('global-b'), batch('global-c')], async b => {
    started.push(b.key);
    if (b.key === 'fresh') { await fresh.promise; return; }
    active++; peak = Math.max(peak, active);
    if (active === 2) bothStarted.resolve();
    await release.promise;
    active--;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['fresh']);
  fresh.resolve(); await bothStarted.promise;
  assert.equal(peak, 2);
  assert.deepEqual(started, ['fresh', 'global-a', 'global-b'], 'a third stack stays queued until capacity is released');
  release.resolve();
  assert.ok((await pending).every(result => result.status === 'fulfilled'));
  assert.ok(started.includes('global-c'));
});

test('serial diagnosis executes every batch and a rejected worker never drops sibling evidence', async () => {
  const started = [];
  const results = await runMockedBatches([batch('a'), batch('b'), batch('c')], async b => {
    started.push(b.key);
    if (b.key === 'a') throw new Error('stack startup failed');
  }, { workers: 1 });
  assert.deepEqual(started, ['a', 'b', 'c']);
  assert.deepEqual(results.map(r => r.status), ['rejected', 'fulfilled', 'fulfilled']);
  assert.equal(mockedWorkers(), 2);
  for (const value of ['0', '3', '2x', '']) assert.throws(() => mockedWorkers(value), /--workers/);
});

test('concurrent stacks reserve disjoint API, legacy, MCP and Swarm ports, including the startup handoff', async () => {
  const a = await reserveMockedPorts(), b = await reserveMockedPorts();
  try {
    assert.ok(Math.abs(a.base - b.base) > 8);
    assert.equal(Number(a.env.SCIENCE_AGENT_LEGACY_PORT), a.base + 8);
    assert.equal(Number(a.env.JIUWENSWARM_GATEWAY_PORT) + 1000, a.base + 6);
    const probe = createServer();
    const error = await new Promise(resolve => {
      probe.once('error', resolve); probe.listen(a.base + 5, '127.0.0.1');
    });
    assert.equal(error.code, 'EADDRINUSE', 'reserve the fault proxy before its stack starts');
    await a.release();
    const c = await reserveMockedPorts();
    try { assert.ok(Math.abs(a.base - c.base) > 8, 'a released listener still belongs to its starting child'); }
    finally { await c.release(); }
  } finally { await a.release(); await b.release(); }
});
