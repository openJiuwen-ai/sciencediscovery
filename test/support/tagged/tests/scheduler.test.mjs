// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { planGroups, schedule, utWorkers, SWARM, UT_WORKERS } from '../scheduler.mjs';
import { startSwarm, swarmVariables, withoutSwarm } from '../swarm.mjs';
import { invokeWorker } from '../process.mjs';

function scope(t) {
  const root = mkdtempSync(join(tmpdir(), 'ut-pool-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, outputDir: root, env: process.env };
}

const entry = (source, name, tags = [], runner = 'node') =>
  ({ id: `${source}::${name}`, source, runner, tags: ['category:ut', ...tags] });

test('one UT worker count, sized for the public runner, may be narrowed but never widened', () => {
  // Public GitHub-hosted ubuntu-latest: 4 vCPUs, 16 GB RAM. Local runs schedule the same.
  assert.equal(UT_WORKERS, 4);
  assert.equal(utWorkers(), UT_WORKERS);
  assert.equal(utWorkers(undefined), UT_WORKERS);
  for (let value = 1; value <= UT_WORKERS; value++) assert.equal(utWorkers(String(value)), value);
  for (const value of ['', '0', '-1', String(UT_WORKERS + 1), '14', '2.5', '04', 'auto']) {
    assert.throws(() => utWorkers(value), new RegExp(`CI_UT_WORKERS must be an integer from 1 to ${UT_WORKERS}`));
  }
});

test('a test declares JiuwenSwarm; neither its directory nor its file does', () => {
  const groups = planGroups([
    entry('services/api/src/server.test.ts', 'turn', ['swarm:required']),
    entry('services/api/src/server.test.ts', 'settings'),
    entry('services/api/src/dashboard.test.ts', 'boots createApiServer'),
    entry('packages/x/src/y.test.ts', 'turn elsewhere', ['swarm:required']),
    entry('services/adapter/tests/test_a.py', 'unit', [], 'python'),
    entry('services/adapter/tests/test_b.py', 'live', ['swarm:required'], 'python'),
    { id: 'check:typecheck', source: 'test/support/tagged/checks.mjs', runner: 'command', tags: ['category:ut'] },
  ]);
  const view = groups.map(group => [group.source, group.resource, group.entries.map(e => e.id.split('::')[1])]);
  assert.deepEqual(view, [
    ['services/api/src/server.test.ts', SWARM, ['turn']],
    ['services/api/src/server.test.ts', null, ['settings']],
    ['services/api/src/dashboard.test.ts', null, ['boots createApiServer']],
    ['packages/x/src/y.test.ts', SWARM, ['turn elsewhere']],
    ['services/adapter', null, ['unit']],
    ['services/adapter', SWARM, ['live']],
  ]);
  // Each process files its own coverage, so a split file needs two names.
  assert.equal(new Set(groups.map(group => group.name)).size, groups.length);
  assert.equal(groups[0].name, `services/api/src/server.test.ts.${SWARM}`);
  assert.equal(groups[1].name, 'services/api/src/server.test.ts');
});

test('undeclared groups overlap up to the worker count; declared ones never overlap, even across files', async () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => `services/api/src/${name}.test.ts`);
  const entries = files.flatMap((file, index) => [
    entry(file, 'plain'),
    ...(index < 3 ? [entry(file, 'turn', ['swarm:required'])] : []),
  ]);
  const groups = planGroups(entries);
  assert.equal(groups.filter(group => group.resource === SWARM).length, 3);
  let active = 0, peak = 0, swarmActive = 0, swarmPeak = 0, overlapped = false;
  const results = await schedule(groups.map((group, index) => ({ resource: group.resource, run: async () => {
    peak = Math.max(peak, ++active);
    if (group.resource) swarmPeak = Math.max(swarmPeak, ++swarmActive);
    else if (swarmActive) overlapped = true;
    await delay(20);
    if (group.resource) --swarmActive;
    --active;
    return index;
  } })), { workers: UT_WORKERS });
  assert.equal(peak, UT_WORKERS);
  assert.equal(swarmPeak, 1, 'two declaring groups held the one instance at once');
  assert.ok(overlapped, 'undeclared groups must keep running beside the declaring lane');
  assert.deepEqual(results.map(result => result.value), groups.map((_, index) => index));
});

test('bounded workers overlap while the declared lane and result order stay stable', async () => {
  for (const workers of [1, 2, UT_WORKERS]) {
    let active = 0, peak = 0;
    const held = new Set(), started = [], finished = [];
    const resources = [SWARM, SWARM, null, null, null, null];
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
    if (workers === 1) assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
    else assert.ok(finished.indexOf(2) < finished.indexOf(0));
  }
});

test('one failing group does not drop the rest of the frozen plan', async () => {
  const failure = new Error('broken test');
  const results = await schedule([
    { resource: SWARM, run: () => { throw failure; } },
    { resource: SWARM, run: () => 'next declaring group' },
    { resource: null, run: () => 'Python group' },
  ], { workers: 2 });
  assert.equal(results[0].reason, failure);
  assert.deepEqual(results.slice(1).map(item => item.value), ['next declaring group', 'Python group']);
});

test('an undeclared worker never inherits a JiuwenSwarm instance from the shell', () => {
  const shell = { PATH: '/bin', SCIENCE_AGENT_EXECUTOR: 'jiuwenswarm', SCIENCE_AGENT_ADAPTER_URL: 'http://127.0.0.1:4310',
    SCIENCE_AGENT_ADAPTER_TOKEN: 't', JIUWENSWARM_GATEWAY_URL: 'ws://127.0.0.1:1/tui' };
  const isolated = withoutSwarm(shell);
  assert.deepEqual(isolated, { PATH: '/bin' });
  for (const name of ['SCIENCE_AGENT_EXECUTOR', 'SCIENCE_AGENT_ADAPTER_URL']) assert.ok(swarmVariables.includes(name));
  assert.equal(shell.SCIENCE_AGENT_EXECUTOR, 'jiuwenswarm', 'the caller keeps its own copy');
});

/** A stand-in for scripts/with-jiuwenswarm.sh: export, run the command, clean up on exit. */
function fakeWrapper(root, body) {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  const path = join(root, 'scripts', 'with-jiuwenswarm.sh');
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

test('the instance starts once, hands only its own variables over, and stops when released', { timeout: 15_000 }, async t => {
  const { root } = scope(t);
  fakeWrapper(root, [
    `trap 'echo stopped > "${join(root, 'cleanup')}"' EXIT`,
    'echo "starting" >&2',
    'export SCIENCE_AGENT_EXECUTOR=jiuwenswarm SCIENCE_AGENT_ADAPTER_URL=http://127.0.0.1:9 JIUWENSWARM_INSTANCE=sd-test',
    'unset SCIENCE_AGENT_ADAPTER_TOKEN',
    '"$@"',
  ].join('\n'));
  const log = join(root, 'swarm.log');
  const swarm = startSwarm({ root, env: { ...process.env, SCIENCE_AGENT_ADAPTER_TOKEN: 'shell-token' }, log });
  assert.deepEqual(await swarm.ready, {
    SCIENCE_AGENT_EXECUTOR: 'jiuwenswarm', SCIENCE_AGENT_ADAPTER_URL: 'http://127.0.0.1:9', JIUWENSWARM_INSTANCE: 'sd-test',
  });
  assert.equal(existsSync(join(root, 'cleanup')), false, 'held until released');
  assert.equal(await swarm.stop(), 0);
  assert.equal(readFileSync(join(root, 'cleanup'), 'utf8').trim(), 'stopped');
  assert.match(readFileSync(log, 'utf8'), /starting/);
});

test('a wrapper that gives up fails the declaring work with its log, not silently', { timeout: 15_000 }, async t => {
  const { root } = scope(t);
  fakeWrapper(root, 'echo "BLOCKED: JiuwenSwarm did not start" >&2; exit 2');
  const swarm = startSwarm({ root, env: process.env, log: join(root, 'swarm.log') });
  await assert.rejects(swarm.ready, /SWARM_UNAVAILABLE: scripts\/with-jiuwenswarm\.sh exited 2/);
  assert.equal(await swarm.stop(), 2);
  assert.match(readFileSync(join(root, 'swarm.log'), 'utf8'), /did not start/);
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
    { resource: null, run: () => invokeWorker(process.execPath, ['-e', node], { ...options, name: 'node', timeoutMs: 10_000 }) },
    { resource: null, run: () => invokeWorker(process.env.SCIENCE_TEST_PYTHON ?? 'python3', ['-c', python], { ...options, name: 'python', timeoutMs: 10_000 }) },
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
