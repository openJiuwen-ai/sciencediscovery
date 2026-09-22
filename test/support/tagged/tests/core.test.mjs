// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTags, inheritTags, compileSelector } from '../tags.mjs';
import { createPlan, validatePlan, verifyResults, digest } from '../plan.mjs';
import { preflight, hostPlatform } from '../environment.mjs';
import { parse } from '../cli.mjs';

const tags = ['category:ut', 'os:linux', 'os:macos', 'arch:amd64', 'npu:none', 'model:none', 'executor:independent', 'judge:none'];
const item = overrides => ({ id: 'one', source: 'one.test.mjs', sourceHash: 'a'.repeat(64), runner: 'node', tags, ...overrides });
const target = { os: 'linux', arch: 'amd64', executor: 'native' };
const plan = (catalog = [item()], options = {}) => createPlan(catalog, { revision: 'abc123', targets: [target], ...options });
const pass = entry => ({ key: entry.key, outcome: 'PASS', actualTarget: entry.target });

test('tag schema validates all groups and multi-valued capabilities', () => {
  assert.equal(normalizeTags(tags).length, tags.length);
  assert.throws(() => normalizeTags(tags.filter(t => !t.startsWith('judge:'))), /Missing tag group/);
  assert.throws(() => normalizeTags([...tags, 'model:mock']), /Conflicting/);
  assert.throws(() => normalizeTags([...tags, 'model:fake']), /Unknown tag/);
  assert.throws(() => normalizeTags([...tags, 'judge:none']), /Duplicate/);
  assert.throws(() => normalizeTags([...tags, 'executor:native']), /independent/);
});
test('suite defaults are overridden by group, not accidentally unioned', () => {
  const actual = normalizeTags(inheritTags(tags, ['os:windows', 'model:real']));
  assert.deepEqual(actual.filter(t => t.startsWith('os:')), ['os:windows']);
  assert.ok(!actual.includes('model:none'));
});
test('selector boolean precedence, parentheses and negation', () => {
  assert.ok(compileSelector('category:ut and (model:none or model:mock) and not judge:llm')(tags));
  assert.ok(!compileSelector('category:st or category:ut and model:real')(tags));
  assert.throws(() => compileSelector('model:typo or category:ut'), /Unknown/);
  for (const bad of ['category:ut and', '(category:ut', 'category:ut blah', 'category:ut || model:real']) {
    assert.throws(() => compileSelector(bad));
  }
});
test('plan is independent of ambient environment and inventory ordering', () => {
  const first = plan([item(), item({ id: 'two' })]);
  const old = process.env.CI_E2E_BACKEND;
  process.env.CI_E2E_BACKEND = 'anything';
  try { assert.deepEqual(plan([item({ id: 'two' }), item()]), first); }
  finally { if (old === undefined) delete process.env.CI_E2E_BACKEND; else process.env.CI_E2E_BACKEND = old; }
  assert.ok(Object.isFrozen(first.entries[0].target));
  assert.throws(() => { first.entries.pop(); });
});
test('concrete OS instance is selected correctly for multi-OS tests', () => {
  const actual = plan([item()], { targets: [target, { ...target, os: 'macos' }], selector: 'not os:linux' });
  assert.equal(actual.entries.length, 1);
  assert.equal(actual.entries[0].target.os, 'macos');
});
test('independent tests run once per OS/arch, not once per product executor', () => {
  const actual = plan([item()], { targets: [target, { ...target, executor: 'jiuwenswarm' }, target] });
  assert.equal(actual.entries.length, 1);
  assert.equal(actual.entries[0].target.executor, 'independent');
});
test('unsupported combination and empty selection fail explicitly', () => {
  assert.throws(() => plan([item()], { selector: 'npu:required' }), /EMPTY_SELECTION/);
  assert.throws(() => plan([item({ tags: tags.filter(t => t !== 'executor:independent').concat('executor:native') })], { targets: [{ ...target, executor: 'jiuwenswarm' }] }), /EMPTY_SELECTION/);
  assert.throws(() => createPlan([item()], { revision: 'x' }), /explicit target/);
  assert.throws(() => plan([item(), item()]), /Duplicate/);
});
test('plan digest detects any accidental mutation', () => {
  const copy = JSON.parse(JSON.stringify(plan()));
  copy.entries[0].target.os = 'windows';
  assert.throws(() => validatePlan(copy), /PLAN_CHANGED/);
});
test('equal counts with wrong identities never pass', () => {
  const p = plan([item(), item({ id: 'two' })]);
  const result = verifyResults(p, [pass(p.entries[0]), pass(p.entries[0])]);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.problems.some(p => p.startsWith('DUPLICATE')));
  assert.ok(result.problems.some(p => p.startsWith('NOT_RUN')));
});
test('skip, xfail, todo, missing and wrong-executor outcomes fail the plan', () => {
  const p = plan();
  for (const outcome of ['FAIL', 'SKIPPED', 'XFAIL', 'XPASS', 'TODO', 'BLOCKED', 'NOT_RUN']) {
    assert.equal(verifyResults(p, [{ ...pass(p.entries[0]), outcome }]).exitCode, 1);
  }
  assert.equal(verifyResults(p, []).exitCode, 1);
  assert.equal(verifyResults(p, [{ ...pass(p.entries[0]), actualTarget: target }]).exitCode, 1);
  assert.equal(verifyResults(p, [pass(p.entries[0])]).exitCode, 0);
  assert.equal(verifyResults(p, [pass(p.entries[0])], ['after-hook failed']).exitCode, 1);
});
test('environment preflight never changes a plan', async () => {
  const p = plan();
  const snapshot = JSON.stringify(p);
  const bad = await preflight(p, { platform: 'darwin', arch: 'arm64', env: {} });
  assert.equal(bad.ok, false);
  assert.equal(JSON.stringify(p), snapshot);
  assert.equal((await preflight(p, { platform: 'linux', arch: 'x64', env: {} })).ok, true);
});
test('real subject and live judge requirements remain orthogonal', async () => {
  const jt = tags.filter(t => t !== 'judge:none').concat('judge:llm');
  const p = plan([item({ tags: jt })]);
  const bad = await preflight(p, { platform: 'linux', arch: 'x64', env: {} });
  assert.ok(bad.problems.some(p => p.requirement === 'E2E_JUDGE_TOKEN'));
  assert.ok(!bad.problems.some(p => p.requirement === 'E2E_LLM_TOKEN'));
});
test('NPU is verified by a probe, never by the presence of an environment variable', async () => {
  const p = plan([item({ tags: tags.filter(t => t !== 'npu:none').concat('npu:required') })]);
  const context = { platform: 'linux', arch: 'x64', env: { NPU_AVAILABLE: '1' } };
  assert.equal((await preflight(p, context)).ok, false);
  assert.equal((await preflight(p, { ...context, probes: { npu: async () => true } })).ok, true);
});
test('CLI rejects changed policy, unknown flags and mixed frozen/new selections', () => {
  assert.throws(() => parse(['run', '--profile', 'pr', '--os', 'linux']), /cannot be overridden/);
  assert.throws(() => parse(['run', '--plan', 'a.json', '--select', 'category:ut']), /cannot be combined/);
  assert.throws(() => parse(['run', '--fake']), /Unknown/);
  assert.throws(() => parse(['run', '--os', 'linux', '--os', 'macos']), /Duplicate/);
});
test('the plan ignores the host platform while the compatibility shim honours it', async () => {
  const { createTest } = await import('../compat.mjs');
  const here = hostPlatform(process.platform);
  const elsewhere = ['linux', 'macos', 'windows'].find(name => name !== here);
  const base = tags.filter(t => !t.startsWith('os:'));
  // The frozen plan selects a foreign-platform case on the target it names, on
  // any machine; only `node --test` outside a plan declines to register it.
  const foreign = plan([item({ tags: [...base, `os:${elsewhere}`] })], {
    targets: [{ os: elsewhere, arch: 'amd64', executor: 'independent' }],
  });
  assert.equal(foreign.entries.length, 1);
  const inert = createTest(import.meta.url, { tags: [...base, `os:${elsewhere}`] });
  assert.notEqual(inert.test, test);
  // Registering would make this file fail: the body throws if it ever runs.
  assert.equal(inert.test('never registered on this host', () => { throw new Error('must not run'); }), undefined);
  assert.equal(createTest(import.meta.url, { tags: [...base, `os:${here}`] }).test, test);
});
