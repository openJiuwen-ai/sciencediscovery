// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createTest } from '../test/support/tagged/compat.mjs';
import { gate, route } from './tier-policy.mjs';

const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });
const readWorkflow = name => readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
const workflow = readWorkflow('ci');
const realWorkflow = readWorkflow('real-e2e');
const jobs = Object.fromEntries([workflow, realWorkflow].flatMap(text =>
  text.slice(text.indexOf('\njobs:\n')).split(/\n(?=  [\w-]+:\n)/).slice(1)
    .map(block => [block.match(/^  ([\w-]+):/)[1], block])));
const condition = block => block.match(/\bif: (?:>-\s*)?\$\{\{([\s\S]*?)\}\}/)?.[1].trim();
const dependencies = name => (jobs[name].match(/^    needs: (.+)/m)?.[1] ?? '').replace(/[\[\]]/g, '').split(', ').filter(Boolean);
const hermetic = ['l1', 'ut', 'st', 'e2e-plan', 'e2e'];
const required = dependencies('merge-gate');
function results(profile, event = 'workflow_dispatch') {
  const needs = Object.fromEntries(required.map(name => [name, { result: 'success', outputs: {} }]));
  const policy = route(event, profile);
  needs.policy.outputs = Object.fromEntries(Object.entries(policy).map(([key, value]) => [key, String(value)]));
  for (const name of ['real-merge', 'real-scheduled']) {
    if (name !== (policy.profile === 'merge' ? 'real-merge' : policy.profile === 'pr' ? null : 'real-scheduled')) needs[name].result = 'skipped';
  }
  if (policy.profile === 'pr') for (const name of ['binary', 'docker']) needs[name].result = 'skipped';
  return needs;
}

// Evaluate actual workflow expressions, including GitHub's implicit success().
// This suite uses the JS-compatible boolean/string subset; bracket access
// preserves GitHub job IDs containing hyphens.
function eligible(expression, needs, { event = 'workflow_dispatch', profile = 'daily', cancelled = false, success = true } = {}) {
  if (!expression) return success;
  if (!/\b(?:always|cancelled|success|failure)\(/.test(expression) && !success) return false;
  const source = expression.replace(/needs\.([\w-]+)/g, (_, name) => `needs[${JSON.stringify(name)}]`);
  return runInNewContext(source, {
    needs, inputs: { profile }, github: { event_name: event }, always: () => true,
    cancelled: () => cancelled, success: () => success, failure: () => !success,
  }, { timeout: 100 });
}
function runnable(name, needs, options = {}) {
  const deps = dependencies(name).map(id => needs[id]?.result);
  if (deps.some(result => !['success', 'failure', 'skipped', 'cancelled'].includes(result))) return false;
  return eligible(condition(jobs[name]), needs, { ...options, success: deps.every(result => result === 'success') });
}

for (const profile of ['daily', 'release']) {
  test(`${profile}: real suite starts while L1/L2 are still running, even after failures`, () => {
    assert.deepEqual(dependencies('real-scheduled'), ['policy']);
    // No hidden wait inside the called workflow before planning or workers.
    assert.deepEqual(dependencies('real-plan'), []);
    assert.deepEqual(dependencies('real-e2e'), ['real-plan']);
    assert.deepEqual(dependencies('real-report'), ['real-plan', 'real-e2e']);
    for (const result of ['queued', 'in_progress', 'failure', 'skipped', 'cancelled']) {
      const needs = results(profile);
      for (const name of hermetic) needs[name].result = result;
      assert.equal(runnable('real-scheduled', needs), true, result);
      assert.equal(runnable('real-merge', needs), false, result);
    }
    assert.equal(runnable('real-scheduled', results(profile), { cancelled: true }), false);
    for (const result of ['in_progress', 'failure', 'skipped', 'cancelled']) {
      const needs = results(profile); needs.policy.result = result;
      assert.equal(runnable('real-scheduled', needs), false);
    }
  });
}

test('L3 starts only after all L1/L2 jobs succeed, including a one-PR merge group', () => {
  assert.deepEqual(dependencies('real-merge'), ['policy', ...hermetic]);
  for (const requested of ['pr', 'merge', 'daily', 'release']) {
    const needs = results(requested, 'merge_group');
    assert.equal(runnable('real-merge', needs, { event: 'merge_group' }), true);
    assert.equal(runnable('real-scheduled', needs, { event: 'merge_group' }), false);
  }
  for (const name of ['policy', ...hermetic]) {
    for (const result of ['queued', 'in_progress', 'failure', 'skipped', 'cancelled']) {
      const needs = results('merge'); needs[name].result = result;
      assert.equal(runnable('real-merge', needs), false, `${name}: ${result}`);
    }
  }
  assert.equal(runnable('real-merge', results('merge'), { cancelled: true }), false);
});

test('both entry points reuse the same suite, profile, backend and inherited secrets', () => {
  for (const name of ['real-merge', 'real-scheduled']) {
    assert.match(jobs[name], /uses: \.\/\.github\/workflows\/real-e2e.yml/);
    assert.match(jobs[name], /secrets: inherit/);
    assert.match(jobs[name], /profile: \$\{\{ needs.policy.outputs.profile \}\}/);
    assert.match(jobs[name], /backend: \$\{\{ needs.policy.outputs.backend \}\}/);
  }
  assert.match(realWorkflow, /on:\n  workflow_call:/);
  assert.doesNotMatch(realWorkflow, /^  (push|schedule|workflow_dispatch|pull_request):/m);
});

test('real workers require their own plan and respect cancellation', () => {
  for (const result of ['success', 'queued', 'in_progress', 'failure', 'skipped', 'cancelled']) {
    const needs = { 'real-plan': { result } };
    assert.equal(runnable('real-e2e', needs), result === 'success');
    assert.equal(runnable('real-e2e', needs, { cancelled: true }), false);
  }
});

test('only L3 downloads and reconciles mocked artifacts before freezing real cases', () => {
  const steps = jobs['real-plan'].split(/\n      - /).filter(step => step.includes('.ci-mocked-'));
  assert.equal(steps.length, 3, 'parent plan, worker artifacts and reconciliation');
  for (const step of steps) {
    for (const profile of ['merge', 'daily', 'release']) {
      assert.equal(eligible(condition(step), {}, { profile }), profile === 'merge');
    }
    assert.equal(eligible(condition(step), {}, { profile: 'merge', success: false }), false);
  }
});

test('PR events never enable real entry points or credentialed workers', () => {
  for (const name of ['real-merge', 'real-scheduled', 'real-plan', 'real-e2e']) {
    for (const profile of ['pr', 'merge', 'daily', 'release']) {
      const needs = { ...results(profile), 'real-plan': { result: 'success' } };
      // Exclude PRs even with a malformed paid routing output or direct child call.
      assert.equal(eligible(condition(jobs[name]), needs, { profile, event: 'pull_request' }), false);
    }
  }
  for (const name of ['real-merge', 'real-scheduled']) assert.equal(runnable(name, results('pr')), false);
});

test('policy does not depend on L1 and other checks retain their original L1 prerequisite', () => {
  assert.doesNotMatch(jobs.policy, /^    needs:|pnpm ci:l1|secrets\./m);
  assert.match(jobs.policy, /run: node \.ci\/tier-policy.mjs/);
  assert.doesNotMatch(workflow, /needs\.l1\.outputs\./);
  for (const name of required) {
    if (jobs[name].includes('needs.policy.')) assert.ok(dependencies(name).includes('policy'), name);
  }
  for (const name of ['ut', 'st', 'e2e-plan', 'e2e', 'binary', 'docker']) {
    assert.ok(dependencies(name).includes('l1'), name);
    assert.equal(eligible(condition(jobs[name]), results('daily'), { success: false }), false);
  }
});

test('accounting and the final gate reject failures and unexpected paid jobs', () => {
  assert.equal(eligible(condition(jobs['real-report']), {}, { success: false }), true);
  for (const profile of ['pr', 'merge', 'daily', 'release']) {
    const needs = results(profile);
    assert.deepEqual(gate(profile, needs), []);
    for (const name of required) {
      const invalid = needs[name].result === 'skipped' ? ['success', 'failure', 'cancelled'] : ['failure', 'skipped', 'cancelled'];
      for (const result of [...invalid, undefined]) {
        assert.ok(gate(profile, { ...needs, [name]: { result } }).length, `${profile}: ${name}: ${result}`);
      }
    }
  }
  const publish = readWorkflow('release').split('  publish:\n')[1];
  assert.match(publish, /^    needs: \[version, gate\]/m);
  assert.doesNotMatch(publish, /^    if:/m, 'publication still requires the called workflow to succeed');
});
