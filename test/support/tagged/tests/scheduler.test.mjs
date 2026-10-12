// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { groupResource, schedule, utWorkers } from '../scheduler.mjs';
import { invokeWorker } from '../process.mjs';

function scope(t) {
  const root = mkdtempSync(join(tmpdir(), 'ut-pool-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, outputDir: root, env: process.env };
}

test('UT worker count is bounded and shared API/Python resources are explicit', () => {
  assert.equal(utWorkers(), 2);
  for (const value of ['1', '2', '3', '4']) assert.equal(utWorkers(value), Number(value));
  for (const value of ['', '0', '-1', '5', '2.5', 'auto']) assert.throws(() => utWorkers(value), /CI_UT_WORKERS/);
  assert.equal(groupResource('services/api/src/server.test.ts', 'node'), 'api');
  assert.equal(groupResource('services/evolve', 'python'), 'python');
  assert.equal(groupResource('services/runner/src/server.test.ts', 'node'), null);
});

test('bounded workers overlap while resource lanes and result order stay stable', async () => {
  for (const workers of [1, 2, 4]) {
    let active = 0, peak = 0;
    const held = new Set(), started = [], finished = [];
    const resources = ['api', 'api', 'python', 'python', null, null];
    const results = await schedule(resources.map((resource, index) => ({ resource, run: async () => {
      if (resource) { assert.ok(!held.has(resource)); held.add(resource); }
      started.push(index); peak = Math.max(peak, ++active);
      await delay(index === 0 ? 40 : 5);
      --active; if (resource) held.delete(resource);
      finished.push(index); return index;
    } })), { workers });
    assert.equal(peak, workers);
    assert.deepEqual(results.map(result => result.value), [0, 1, 2, 3, 4, 5]);
    assert.ok(started.indexOf(0) < started.indexOf(1));
    assert.ok(started.indexOf(2) < started.indexOf(3));
    if (workers === 1) assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
    else assert.ok(finished.indexOf(2) < finished.indexOf(0));
  }
});

test('one failing group does not drop the rest of the frozen plan', async () => {
  const failure = new Error('broken test');
  const results = await schedule([
    { resource: 'api', run: () => { throw failure; } },
    { resource: 'api', run: () => 'next API group' },
    { resource: 'python', run: () => 'Python group' },
  ], { workers: 2 });
  assert.equal(results[0].reason, failure);
  assert.deepEqual(results.slice(1).map(item => item.value), ['next API group', 'Python group']);
});

test('cancellation stops queued groups and leaves them explicitly rejected', async () => {
  const controller = new AbortController();
  const results = await schedule([
    { run: () => { controller.abort(); return 'started'; } },
    { run: () => { throw new Error('must never start'); } },
  ], { workers: 1, signal: controller.signal });
  assert.equal(results[0].value, 'started');
  assert.match(results[1].reason.message, /aborted/);
});

test('Node and Python subprocesses can rendezvous without blocking the coordinator', { timeout: 15_000 }, async t => {
  const options = scope(t);
  const node = `const fs=require('node:fs');fs.writeFileSync('node-ready','');const timer=setInterval(()=>{if(fs.existsSync('python-ready')){clearInterval(timer);console.log('node saw Python');}},10);`;
  const python = "from pathlib import Path\nimport time\nPath('python-ready').touch()\nwhile not Path('node-ready').exists(): time.sleep(.01)\nprint('Python saw node')\n";
  const results = await schedule([
    { resource: 'api', run: () => invokeWorker(process.execPath, ['-e', node], { ...options, name: 'node', timeoutMs: 10_000 }) },
    { resource: 'python', run: () => invokeWorker(process.env.SCIENCE_TEST_PYTHON ?? 'python3', ['-c', python], { ...options, name: 'python', timeoutMs: 10_000 }) },
  ], { workers: 2 });
  assert.deepEqual(results.map(item => item.value.status), [0, 0]);
  assert.match(results[0].value.stdout, /node saw Python/);
  assert.match(results[1].value.stdout, /Python saw node/);
  assert.ok(JSON.parse(readFileSync(join(options.root, 'python-timing.json'))).durationMs >= 0);
});

test('worker preserves failure output and spawn errors', async t => {
  const options = scope(t);
  const failed = await invokeWorker(process.execPath, ['-e', "console.error('assertion failed');process.exitCode=7"], { ...options, name: 'failed' });
  assert.equal(failed.status, 7);
  assert.match(readFileSync(join(options.root, 'failed.log'), 'utf8'), /assertion failed/);
  const missing = await invokeWorker(join(options.root, 'missing-executable'), [], { ...options, name: 'missing' });
  assert.equal(missing.error.code, 'ENOENT');
  assert.equal(missing.status, null);
});

test('timeout and cancellation stop workers and persist diagnostics', { timeout: 10_000 }, async t => {
  const options = scope(t);
  const timed = await invokeWorker(process.execPath, ['-e', 'setInterval(()=>{},100)'], { ...options, name: 'timeout', timeoutMs: 100 });
  assert.match(timed.error.message, /WORKER_TIMEOUT/);
  assert.equal(timed.status, null);
  const controller = new AbortController();
  const pending = invokeWorker(process.execPath, ['-e', 'setInterval(()=>{},100)'], { ...options, name: 'cancelled', signal: controller.signal });
  controller.abort();
  assert.match((await pending).error.message, /WORKER_ABORTED/);
  assert.match(readFileSync(join(options.root, 'cancelled.log'), 'utf8'), /WORKER_ABORTED/);
});

test('cancellation also stops a grandchild that ignores SIGTERM', { timeout: 15_000 }, async t => {
  if (process.platform === 'win32') {
    // Windows has no POSIX process groups; the worker itself is covered above.
    assert.equal(process.platform, 'win32');
    return;
  }
  const options = scope(t), controller = new AbortController();
  const heartbeat = join(options.root, 'heartbeat'), pidFile = join(options.root, 'pid');
  const grandchild = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),10);`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},100);`;
  const pending = invokeWorker(process.execPath, ['-e', parent], { ...options, name: 'tree', timeoutMs: 10_000, signal: controller.signal });
  t.after(async () => { controller.abort(); await pending; });
  for (let n = 0; n < 500 && !existsSync(heartbeat); n++) await delay(10);
  assert.ok(existsSync(heartbeat), 'grandchild must start before cancellation');
  controller.abort();
  assert.match((await pending).error.message, /WORKER_ABORTED/);
  await delay(50);
  const finalBeat = readFileSync(heartbeat, 'utf8');
  await delay(100);
  assert.equal(readFileSync(heartbeat, 'utf8'), finalBeat, 'grandchild must stop writing');
});

test('excessive worker output fails with bounded retained diagnostics', async t => {
  const options = scope(t);
  const result = await invokeWorker(process.execPath, ['-e', "setInterval(()=>process.stdout.write('x'.repeat(1024*1024)),1)"], { ...options, name: 'output', timeoutMs: 5_000 });
  assert.match(result.error.message, /WORKER_OUTPUT_LIMIT/);
  assert.ok(Buffer.byteLength(result.stdout) <= 16 * 1024 * 1024);
});
