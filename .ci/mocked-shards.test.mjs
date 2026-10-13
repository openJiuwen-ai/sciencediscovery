// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTest } from '../test/support/tagged/compat.mjs';
import { createPlan, subplan, verifyResults } from '../test/support/tagged/plan.mjs';
import { mockedShards, assertMockedOrder, swarmChecks } from '../test/support/tagged/execution.mjs';
import { reconcileMocked } from './mocked-report.mjs';
const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });
const descriptor = (id, extra = []) => ({ id, source: `test/${id}.spec.ts`, sourceHash: 'a'.repeat(64), runner: 'playwright', tags: ['category:e2e', 'os:linux', 'arch:amd64', 'model:mock', ...extra] });
const catalog = [descriptor('fresh', ['isolation:fresh']), descriptor('settings', ['isolation:global']), descriptor('journey', ['isolation:session']), descriptor('research', ['fixture:research']), descriptor('literature', ['fixture:literature'])];
const plan = (entries = catalog, backend = 'jiuwenswarm') => createPlan(entries, { revision: 'candidate', profile: 'pr', targets: [{ os: 'linux', arch: 'amd64' }], execution: { backend } });
const pass = e => ({ key: e.key, outcome: 'PASS', actualTarget: e.target, actualBackend: e.backend });
function evidence(t, p = plan()) {
  const root = mkdtempSync(join(tmpdir(), 'mocked-shards-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const shard of mockedShards(p)) {
    const base = join(root, `mocked-e2e-results-${shard.name}`), dir = join(base, 'e2e/tagged');
    mkdirSync(dir, { recursive: true });
    const worker = subplan(p, p.entries.filter(e => shard.keys.includes(e.key)));
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(worker));
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(verifyResults(worker, worker.entries.map(pass))));
    if (shard.checks.length) {
      const checkDir = join(base, `mocked-${shard.fixture}/e2e`); mkdirSync(checkDir, { recursive: true });
      writeFileSync(join(checkDir, 'jiuwenswarm-checks.json'), JSON.stringify(shard.checks.map(name => ({ name, outcome: 'PASS' }))));
    }
  }
  return root;
}
const file = (root, path) => join(root, 'mocked-e2e-results-standard-config', path);

test('mocked partitions keep standard fixtures and select the same cases for each backend', () => {
  const a = plan(), b = plan(catalog, 'legacy'), shards = mockedShards(a);
  assert.deepEqual(shards.map(s => [s.name, s.fixture, s.keys.length]), [
    ['literature', 'literature', 1], ['research', 'research', 1], ['standard-config', 'standard', 2], ['standard-journeys', 'standard', 1],
  ]);
  assert.deepEqual(shards.flatMap(s => s.keys).sort(), a.entries.map(e => e.key).sort());
  assert.deepEqual(a.entries.map(e => e.id), b.entries.map(e => e.id));
  assert.deepEqual(shards.flatMap(s => s.checks), swarmChecks);
  assert.deepEqual(mockedShards(b).flatMap(s => s.checks), []);
  assert.throws(() => mockedShards(plan([descriptor('new')])), /MOCKED_ISOLATION_REQUIRED/);
  assert.throws(() => mockedShards(plan([descriptor('one', ['isolation:global']), { ...descriptor('two', ['isolation:session']), source: 'test/one.spec.ts' } ])), /SPLIT_MOCKED_FILE/);
});

test('fresh-library journeys precede global mutation and cannot run with multiple workers', () => {
  const fresh = catalog[0], global = catalog[1], session = catalog[2], config = { workers: 1, fullyParallel: false };
  assert.doesNotThrow(() => assertMockedOrder([session, fresh, global], config));
  assert.throws(() => assertMockedOrder([global, fresh], config), /MUST_RUN_FIRST/);
  assert.throws(() => assertMockedOrder([fresh], { ...config, workers: 2 }), /SERIAL_WORKER/);
  assert.throws(() => assertMockedOrder([fresh], { ...config, fullyParallel: true }), /SERIAL_WORKER/);
});

test('complete mocked browser and supplemental evidence passes for both backends', t => {
  for (const backend of ['jiuwenswarm', 'legacy']) {
    const p = plan(catalog, backend), root = evidence(t, p);
    const result = reconcileMocked(p, root);
    assert.equal(result.status, 'PASS'); assert.equal(result.planned, 5); assert.equal(result.passed, 5);
  }
});

test('missing worker, skipped case, duplicate result and failed driver cannot produce a green suite', t => {
  for (const mutation of ['missing', 'skipped', 'duplicate', 'driver']) {
    const p = plan(), root = evidence(t, p), path = file(root, 'e2e/tagged/summary.json');
    const summary = JSON.parse(readFileSync(path));
    if (mutation === 'missing') rmSync(path);
    else {
      if (mutation === 'skipped') summary.results[0].outcome = 'SKIPPED';
      if (mutation === 'duplicate') summary.results.push(summary.results[0]);
      if (mutation === 'driver') summary.status = 'FAIL';
      writeFileSync(path, JSON.stringify(summary));
    }
    assert.equal(reconcileMocked(p, root).exitCode, 1, mutation);
  }
});

test('mocked reconciliation rejects source, revision, backend and case-set drift', t => {
  for (const mutation of ['source', 'revision', 'backend', 'case-set']) {
    const p = plan(), root = evidence(t, p), path = file(root, 'e2e/tagged/plan.json');
    let worker = JSON.parse(readFileSync(path));
    if (mutation === 'source') worker.entries[0].sourceHash = 'b'.repeat(64);
    if (mutation === 'revision') worker.revision = 'other';
    if (mutation === 'backend') {
      const other = plan(catalog, 'legacy');
      worker = subplan(other, other.entries.filter(e => ['fresh', 'settings'].includes(e.id)));
    }
    if (mutation === 'case-set') worker.entries.pop();
    const drift = subplan(worker, worker.entries);
    writeFileSync(path, JSON.stringify(drift));
    writeFileSync(file(root, 'e2e/tagged/summary.json'), JSON.stringify(verifyResults(drift, drift.entries.map(pass))));
    assert.ok(reconcileMocked(p, root).problems.some(p => p.includes('SHARD_IDENTITY_MISMATCH')), mutation);
  }
});

test('a failed case remains executed and failed in the suite totals', t => {
  const p = plan(), root = evidence(t, p), path = file(root, 'e2e/tagged/summary.json');
  const summary = JSON.parse(readFileSync(path));
  summary.results[0].outcome = 'FAIL'; summary.status = 'FAIL';
  writeFileSync(path, JSON.stringify(summary));
  const result = reconcileMocked(p, root);
  assert.equal(result.status, 'FAIL'); assert.equal(result.executed, 5);
  assert.equal(result.passed, 4); assert.equal(result.failed, 1);
  assert.ok(!result.problems.some(p => p.startsWith('NOT_RUN:')));
});

test('supplemental checks must run once, in order, on their designated stack', t => {
  for (const mutation of ['missing', 'omitted', 'duplicate', 'failed', 'order', 'wrong-worker']) {
    const p = plan(), root = evidence(t, p), path = file(root, 'mocked-standard/e2e/jiuwenswarm-checks.json');
    const checks = JSON.parse(readFileSync(path));
    if (mutation === 'missing') rmSync(path);
    else if (mutation === 'wrong-worker') {
      const dest = join(root, 'mocked-e2e-results-standard-journeys/mocked-standard/e2e'); mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'jiuwenswarm-checks.json'), JSON.stringify(checks));
    } else {
      if (mutation === 'omitted') checks.pop();
      if (mutation === 'duplicate') checks.push(checks[0]);
      if (mutation === 'failed') checks[0].outcome = 'FAIL';
      if (mutation === 'order') checks.reverse();
      writeFileSync(path, JSON.stringify(checks));
    }
    assert.equal(reconcileMocked(p, root).exitCode, 1, mutation);
  }
});

test('workflow freezes before dispatch and reconciles before L3 paid calls and the merge gate', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = name => workflow.split(`  ${name}:\n`)[1].split(/\n  [a-z][a-z-]*:\n/)[0];
  assert.match(job('e2e'), /needs: \[policy, l1, e2e-plan\]/);
  assert.match(job('e2e'), /max-parallel: 4/);
  assert.match(job('e2e'), /fail-fast: false/);
  assert.match(job('e2e'), /--shard \$\{\{ matrix.shard \}\}/);
  for (const name of ['real-plan', 'merge-gate']) {
    assert.match(job(name), /path: \.ci-mocked-results\n/);
    assert.match(job(name), /node \.ci\/mocked-report.mjs \.ci-mocked-plan\/plan.json \.ci-mocked-results/);
  }
});
