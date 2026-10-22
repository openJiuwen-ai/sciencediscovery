// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTest } from '../test/support/tagged/compat.mjs';
import { claGate, mergeGroupPullRequestNumber } from './tier-policy.mjs';

const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });
const bot = { login: 'sciencediscovery-bot[bot]', type: 'Bot' };
const human = { login: 'contributor', type: 'User' };
const status = state => ({ context: 'license/cla', state });

for (const [name, statuses, user, ok, message] of [
  ['absent context', [{ context: 'other', state: 'pending' }], human, true, /context absent/],
  ['success', [status('success')], human, true, /success/],
  ['pending Bot', [status('pending')], bot, true, /pending; allowed for Bot PR author sciencediscovery-bot\[bot\]/],
  ['pending human', [status('pending')], human, false, /pending/],
  ['failure Bot', [status('failure')], bot, true, /failure; allowed for Bot PR author/],
  ['error human', [status('error')], human, false, /error/],
  ['Bot-like login is not a Bot type', [status('pending')], { ...bot, type: 'User' }, false, /pending/],
  ['unknown author', [status('pending')], null, false, /no Bot PR author exemption/],
]) {
  test(`CLA policy: ${name}`, () => {
    for (const event of ['pull_request', 'merge_group']) {
      const result = claGate(event, { statuses, user });
      assert.equal(result.ok, ok);
      assert.match(result.message, message);
    }
  });
}

test('CLA policy uses the latest exact context, rather than the combined state or an older success', () => {
  assert.equal(claGate('pull_request', { statuses: [status('pending'), status('success')], user: human }).ok, false);
  assert.equal(claGate('pull_request', { statuses: [status('success'), status('error')], user: human }).ok, true);
  assert.equal(claGate('pull_request', { statuses: [{ context: 'LICENSE/CLA', state: 'failure' }] }).ok, true);
  assert.equal(claGate('pull_request', { statuses: [] }).ok, true);
});

test('CLA status API failures and missing responses fail even for Bot PR authors', () => {
  for (const event of ['pull_request', 'merge_group']) {
    const result = claGate(event, { statuses: [], user: bot, error: 'HTTP 403: Resource not accessible by integration' });
    assert.equal(result.ok, false);
    assert.match(result.message, /could not read commit statuses: HTTP 403/);
    assert.equal(claGate(event).ok, false);
  }
});

test('push and manual runs do not fail because of CLA', () => {
  for (const event of ['push', 'workflow_dispatch', 'schedule']) {
    assert.equal(claGate(event, { statuses: [status('failure')], user: human, error: 'HTTP 500' }).ok, true);
  }
});

test('merge-group PR numbers come only from queue refs', () => {
  assert.equal(mergeGroupPullRequestNumber('refs/heads/gh-readonly-queue/main/pr-408-abcdef'), 408);
  assert.equal(mergeGroupPullRequestNumber('refs/heads/gh-readonly-queue/release/v1/pr-42-abcdef'), 42);
  for (const ref of [undefined, '', 'refs/heads/main', 'refs/pull/408/merge', 'refs/heads/pr-408-abcdef',
    'refs/heads/gh-readonly-queue/main/pr-0-abcdef', 'refs/heads/gh-readonly-queue/main/pr-9007199254740992-abcdef']) {
    assert.equal(mergeGroupPullRequestNumber(ref), null);
  }
});

// Execute the actual workflow's collection step with API fixtures; no network calls.
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
test('merge-gate has exactly the CLA read permissions while workflow defaults stay contents-only', () => {
  const mergeGateJob = workflow.split('\n  merge-gate:\n')[1].split(/\n(?=  [\w-]+:\n)/)[0];
  const defaults = workflow.match(/^permissions:\n((?: {2}\S[^\n]*\n)+)/m)?.[1];
  const jobPermissions = mergeGateJob.match(/^    permissions:\n((?: {6}\S[^\n]*\n)+)/m)?.[1];
  assert.ok(defaults, 'workflow-level permissions must remain explicit');
  assert.ok(jobPermissions, 'merge-gate must grant its own read permissions');
  const entries = block => block.trim().split('\n').map(line => line.trim()).sort();
  assert.deepEqual(entries(defaults), ['contents: read']);
  assert.deepEqual(entries(jobPermissions), ['contents: read', 'pull-requests: read', 'statuses: read']);
  for (const block of [defaults, mergeGateJob]) {
    assert.doesNotMatch(block, /\b(?:statuses|pull-requests):\s*write\b/);
  }
});

const collectionStep = workflow.split('      - name: Read CLA inputs\n')[1].split('\n      - name: Require CLA policy')[0];
const script = collectionStep.split('          script: |\n')[1].replace(/^ {12}/gm, '');
const collect = new (async () => {}).constructor('github', 'context', 'core', 'process', script);
async function inputs(eventName, payload, { statuses = [status('pending')], user = bot, statusError, authorError } = {}) {
  const calls = [], warnings = [];
  const endpoint = {};
  const github = {
    rest: {
      repos: { listCommitStatusesForRef: endpoint },
      pulls: { get: async args => { calls.push(['pull', args]); if (authorError) throw new Error(authorError); return { data: { user } }; } },
    },
    paginate: async (method, args) => {
      assert.equal(method, endpoint);
      calls.push(['statuses', args]);
      if (statusError) throw new Error(statusError);
      return statuses;
    },
  };
  const result = await collect(github, { eventName, payload, actor: bot.login, repo: { owner: 'owner', repo: 'repo' } },
    { warning: message => warnings.push(message), info: () => {} },
    { env: { GITHUB_WORKSPACE: fileURLToPath(new URL('..', import.meta.url)) } });
  return { result, calls, warnings, verdict: claGate(eventName, result) };
}

test('workflow reads the PR head SHA and payload author, even when the actor is a Bot', async () => {
  const { calls, result, verdict } = await inputs('pull_request', { pull_request: { head: { sha: 'pr-head' }, user: human } });
  assert.deepEqual(calls, [['statuses', { owner: 'owner', repo: 'repo', ref: 'pr-head', per_page: 100 }]]);
  assert.equal(result.user, human);
  assert.equal(verdict.ok, false);
});

const group = { head_sha: 'group-head', head_ref: 'refs/heads/gh-readonly-queue/main/pr-408-abcdef' };
test('workflow resolves the merge-group PR author and reads the group head SHA', async () => {
  const { calls, verdict } = await inputs('merge_group', { merge_group: group });
  assert.deepEqual(calls, [
    ['pull', { owner: 'owner', repo: 'repo', pull_number: 408 }],
    ['statuses', { owner: 'owner', repo: 'repo', ref: 'group-head', per_page: 100 }],
  ]);
  assert.equal(verdict.ok, true);
});

test('merge_group without a parseable PR gets no Bot exemption', async () => {
  const { calls, warnings, verdict } = await inputs('merge_group', { merge_group: { ...group, head_ref: 'unknown' } });
  assert.equal(calls.some(([name]) => name === 'pull'), false);
  assert.match(warnings[0], /Could not parse.*no Bot exemption/);
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /license\/cla: pending/);
});

test('merge-group author lookup failure gets no Bot exemption', async () => {
  const { result, warnings, verdict } = await inputs('merge_group', { merge_group: group }, { authorError: 'HTTP 404' });
  assert.equal(result.user, null);
  assert.match(warnings[0], /HTTP 404/);
  assert.equal(verdict.ok, false);
});

test('workflow passes status API errors to the policy instead of returning an absent context', async () => {
  const { result, verdict } = await inputs('pull_request', { pull_request: { head: { sha: 'head' }, user: bot } }, { statusError: 'HTTP 503' });
  assert.equal(result.statuses, undefined);
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /could not read commit statuses: HTTP 503/);
});

test('CLA command exposes the policy failure as a nonzero exit code', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./tier-policy.mjs', import.meta.url)), 'cla'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', CI_CLA_RESULT: JSON.stringify({ statuses: [status('pending')], user: human }) },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /CI gate failed: license\/cla: pending/);
});
