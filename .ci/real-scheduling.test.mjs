// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createTest } from '../test/support/tagged/compat.mjs';
import { gate, route } from './tier-policy.mjs';

const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const job = name => workflow.split(`  ${name}:\n`)[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0];
const condition = block => block.match(/\bif: (?:>-\s*)?\$\{\{([\s\S]*?)\}\}/)?.[1].trim();
const dependencies = name => job(name).match(/^    needs: \[([^\]]+)\]/m)[1].split(', ');
const hermetic = ['l1', 'ut', 'st', 'e2e-plan', 'e2e'];
const required = dependencies('merge-gate');
function results(profile, event = 'workflow_dispatch') {
  const needs = Object.fromEntries(required.map(name => [name, { result: 'success', outputs: {} }]));
  needs.policy.outputs = Object.fromEntries(Object.entries(route(event, profile)).map(([key, value]) => [key, String(value)]));
  return needs;
}

// Evaluate the workflow's actual boolean expressions, including GitHub's implicit
// success() guard. These expressions use the JS-compatible boolean/string subset;
// bracket access preserves GitHub job IDs containing hyphens.
function eligible(expression, needs, { event = 'workflow_dispatch', cancelled = false, success = true } = {}) {
  if (!expression) return success;
  if (!/\b(?:always|cancelled|success|failure)\(/.test(expression) && !success) return false;
  const source = expression.replace(/needs\.([\w-]+)/g, (_, name) => `needs[${JSON.stringify(name)}]`);
  return runInNewContext(source, {
    needs, github: { event_name: event }, always: () => true,
    cancelled: () => cancelled, success: () => success, failure: () => !success,
  }, { timeout: 100 });
}

for (const profile of ['merge', 'daily', 'release']) {
  test(`${profile}: real planning handles failed or skipped hermetic jobs without weakening L3`, () => {
    const expression = condition(job('real-plan'));
    assert.deepEqual(dependencies('real-plan'), ['policy', ...hermetic]);
    assert.equal(eligible(expression, results(profile)), true);
    for (const name of hermetic) {
      for (const result of ['failure', 'skipped', 'cancelled']) {
        const needs = results(profile);
        needs[name].result = result;
        assert.equal(eligible(expression, needs, { success: false }), profile !== 'merge', `${name}: ${result}`);
      }
    }
    const needs = results(profile);
    for (const name of hermetic) needs[name].result = name === 'l1' ? 'failure' : 'skipped';
    assert.equal(eligible(expression, needs, { success: false }), profile !== 'merge', 'L1 fails and L2 never starts');
    for (const result of ['failure', 'skipped', 'cancelled']) {
      needs.policy.result = result;
      assert.equal(eligible(expression, needs, { success: false }), false, 'routing must succeed');
    }
    assert.equal(eligible(expression, results(profile), { cancelled: true }), false);
  });
}

test('real workers require their own plan, ignore failed ancestors and still allow cancellation', () => {
  assert.deepEqual(dependencies('real-e2e'), ['policy', 'real-plan']);
  const expression = condition(job('real-e2e'));
  for (const profile of ['merge', 'daily', 'release']) {
    const needs = results(profile);
    assert.equal(eligible(expression, needs, { success: false }), true);
    assert.equal(eligible(expression, needs, { cancelled: true }), false);
    for (const result of ['failure', 'skipped', 'cancelled']) {
      needs['real-plan'].result = result;
      assert.equal(eligible(expression, needs, { success: false }), false);
    }
  }
});

test('only L3 downloads and reconciles mocked artifacts before freezing real cases', () => {
  const steps = job('real-plan').split(/\n      - /).filter(step => step.includes('.ci-mocked-'));
  assert.equal(steps.length, 3, 'parent plan, worker artifacts and reconciliation');
  for (const step of steps) {
    for (const profile of ['merge', 'daily', 'release']) {
      assert.equal(eligible(condition(step), results(profile)), profile === 'merge');
    }
    assert.equal(eligible(condition(step), results('merge'), { success: false }), false);
  }
});

test('PR events never enable real jobs, including with a paid profile input', () => {
  for (const name of ['real-plan', 'real-e2e']) {
    for (const profile of ['pr', 'merge', 'daily', 'release']) {
      assert.equal(eligible(condition(job(name)), results(profile, 'pull_request'), { event: 'pull_request' }), false);
      // The workflow also excludes PR events even with a malformed paid routing output.
      assert.equal(eligible(condition(job(name)), results(profile), { event: 'pull_request' }), false);
    }
    assert.equal(eligible(condition(job(name)), results('pr')), false);
  }
});

test('policy output does not depend on L1 and every consumer declares the new dependency', () => {
  assert.doesNotMatch(job('policy'), /^    needs:|pnpm ci:l1|secrets\./m);
  assert.match(job('policy'), /run: node \.ci\/tier-policy.mjs/);
  assert.doesNotMatch(workflow, /needs\.l1\.outputs\./);
  for (const name of required) {
    if (job(name).includes('needs.policy.')) assert.ok(dependencies(name).includes('policy'), name);
  }
  for (const name of ['ut', 'st', 'e2e-plan', 'e2e', 'binary', 'docker']) {
    assert.ok(dependencies(name).includes('l1'), `${name} retains its L1 prerequisite`);
    assert.equal(eligible(condition(job(name)), results('daily'), { success: false }), false);
  }
});

test('real accounting survives failed ancestors but successful real cases cannot hide other failures', () => {
  for (const profile of ['merge', 'daily', 'release']) {
    const needs = results(profile);
    assert.equal(eligible(condition(job('real-report')), needs, { success: false }), true);
    assert.deepEqual(gate(profile, needs), []);
    for (const name of required) {
      for (const result of ['failure', 'skipped', 'cancelled']) {
        assert.ok(gate(profile, { ...needs, [name]: { result } }).length, `${profile}: ${name}: ${result}`);
      }
    }
  }
  const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const publish = release.split('  publish:\n')[1];
  assert.match(publish, /^    needs: \[version, gate\]/m);
  assert.doesNotMatch(publish, /^    if:/m, 'publication still requires the called workflow to succeed');
});
