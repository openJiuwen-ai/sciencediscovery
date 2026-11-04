// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createTest } from '../test/support/tagged/compat.mjs';
import { changedPaths, documentationOnly } from './changed-paths.mjs';
import { gate, route } from './tier-policy.mjs';

const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(repository, '.github/workflows/ci.yml'), 'utf8');
const jobs = Object.fromEntries(workflow.split('\njobs:\n')[1].split(/\n(?=  [\w-]+:\n)/).slice(1)
  .map(block => [block.match(/^  ([\w-]+):/)[1], block]));
const condition = block => block.match(/\bif: (?:>-\s*)?\$\{\{([\s\S]*?)\}\}/)?.[1].trim();
const dependencies = name => (jobs[name].match(/^    needs: (.+)/m)?.[1] ?? '').replace(/[\[\]]/g, '').split(', ').filter(Boolean);
const unaffected = ['ut', 'st', 'e2e-plan', 'e2e', 'coverage', 'binary', 'docker', 'real-merge', 'real-scheduled'];

function eligible(expression, needs, { event = 'pull_request', draft = false, success = true, inputs = {} } = {}) {
  if (!expression) return success;
  if (!/\b(?:always|cancelled|success|failure)\(/.test(expression) && !success) return false;
  const source = expression.replace(/needs\.([\w-]+)/g, (_, name) => `needs[${JSON.stringify(name)}]`);
  return runInNewContext(source, {
    needs, inputs, github: { event_name: event, event: { pull_request: { draft } }, workflow: 'CI' },
    always: () => true, cancelled: () => false, success: () => success, failure: () => !success,
    contains: (value, search) => value.includes(search), toJSON: value => JSON.stringify(value),
  }, { timeout: 100 });
}

function selection(event, paths, { draft = false, profile = 'pr' } = {}) {
  const policy = route(event, profile, 'jiuwenswarm', paths);
  const needs = { policy: { result: 'success', outputs: Object.fromEntries(Object.entries(policy).map(([k, v]) => [k, String(v)])) } };
  const pending = new Set(['l1', ...unaffected, 'merge-gate']);
  while (pending.size) {
    const ready = [...pending].filter(name => dependencies(name).every(id => needs[id]));
    assert.ok(ready.length, 'the workflow dependency graph must make progress');
    for (const name of ready) {
      const success = dependencies(name).every(id => needs[id].result === 'success');
      const jobHeader = jobs[name].split('\n    steps:\n')[0];
      needs[name] = { result: eligible(condition(jobHeader), needs, { event, draft, success }) ? 'success' : 'skipped' };
      pending.delete(name);
    }
  }
  return needs;
}

function fixture(t) {
  const parent = join(repository, '.tmp', 'docs-only-tests');
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, 'repository-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git(['init', '--initial-branch=main', '--quiet']);
  const write = (path, text = path) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), text); };
  const commit = () => {
    git(['add', '.']);
    git(['-c', 'user.name=HongyeZhou', '-c', 'user.email=HongyeZhou@users.noreply.github.com',
      'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture']);
    return git(['rev-parse', 'HEAD']).trim();
  };
  write('docs/guide.md'); write('services/README.md');
  const base = commit();
  return { cwd, git, write, commit, base };
}

const payload = (event, base, head) => event === 'pull_request' ? { pull_request: { base: { sha: base }, head: { sha: head } } }
  : event === 'merge_group' ? { merge_group: { base_sha: base, head_sha: head } } : { before: base, after: head };

test('only the explicit documentation allowlist qualifies, regardless of extension', () => {
  const allowed = ['README.md', 'README_zh.md', 'CONTRIBUTING.md', 'LICENSE', 'Third_Party_Open_Source_Software_Notice.txt',
    'docs/guide.md', 'docs/en/reference/nested.md', 'docs/images/example.png'];
  assert.equal(documentationOnly(allowed), true);
  for (const path of ['skills/example.md', 'test/README.md', '.github/workflows/ci.yml', '.ci/README.md', 'packages/example.md',
    'services/README.md', 'apps/web/README.md', 'README.txt', 'docs-other/guide.md', 'Docs/guide.md']) {
    assert.equal(documentationOnly(['docs/guide.md', path]), false, path);
  }
  for (const paths of [null, undefined, [], [''], [null]]) assert.equal(documentationOnly(paths), false);
});

test('PR, push and merge-group read actual history and retain unusual filenames', t => {
  const f = fixture(t);
  const names = ['docs/with spaces.md', 'docs/with\nnewline.md', 'docs/中文.md'];
  for (const name of names) f.write(name);
  const head = f.commit();
  for (const event of ['pull_request', 'push', 'merge_group']) {
    const paths = changedPaths(event, payload(event, f.base, head), { git: f.git });
    assert.deepEqual(paths.sort(), [...names].sort());
    assert.equal(route(event, 'pr', 'jiuwenswarm', paths).docs_only, true);
  }
});

test('PR compares against the merge base while push and merge-group compare exact endpoints', t => {
  const f = fixture(t);
  f.git(['checkout', '--quiet', '-b', 'documentation']);
  f.write('docs/guide.md', 'updated'); const head = f.commit();
  f.git(['checkout', '--quiet', 'main']);
  f.write('services/README.md', 'base moved'); const base = f.commit();
  assert.equal(documentationOnly(changedPaths('pull_request', payload('pull_request', base, head), { git: f.git })), true);
  for (const event of ['push', 'merge_group']) {
    assert.equal(documentationOnly(changedPaths(event, payload(event, base, head), { git: f.git })), false);
  }
});

test('renames check both old and new paths and deletions remain visible', t => {
  const f = fixture(t);
  renameSync(join(f.cwd, 'services/README.md'), join(f.cwd, 'docs/moved.md'));
  const head = f.commit();
  for (const event of ['pull_request', 'push', 'merge_group']) {
    const paths = changedPaths(event, payload(event, f.base, head), { git: f.git });
    assert.deepEqual(paths.sort(), ['docs/moved.md', 'services/README.md']);
    assert.equal(documentationOnly(paths), false);
  }
  mkdirSync(join(f.cwd, 'skills'));
  renameSync(join(f.cwd, 'docs/moved.md'), join(f.cwd, 'skills/moved.md'));
  const outside = f.commit();
  assert.equal(documentationOnly(changedPaths('push', payload('push', head, outside), { git: f.git })), false);
  renameSync(join(f.cwd, 'docs/guide.md'), join(f.cwd, 'docs/renamed.md'));
  const renamed = f.commit();
  assert.equal(documentationOnly(changedPaths('push', payload('push', outside, renamed), { git: f.git })), true);
  rmSync(join(f.cwd, 'docs/renamed.md'));
  assert.deepEqual(changedPaths('push', payload('push', renamed, f.commit()), { git: f.git }), ['docs/renamed.md']);
});

test('unavailable, empty, malformed or truncated diffs retain the full profile', () => {
  const event = payload('push', 'a'.repeat(40), 'b'.repeat(40));
  for (const git of [() => { throw new Error('history unavailable'); }, () => '', () => 'docs/guide.md', () => 'docs/guide.md\0\0']) {
    const paths = changedPaths('push', event, { git });
    assert.equal(route('push', 'pr', 'jiuwenswarm', paths).docs_only, false);
  }
  for (const invalid of [null, {}, payload('push', '0'.repeat(40), 'b'.repeat(40)), payload('push', '--bad-revision', 'b'.repeat(40))]) {
    assert.equal(changedPaths('push', invalid, { git: () => assert.fail('invalid revisions must not reach git') }), null);
  }
});

test('dispatch and reusable calls never inspect diffs or change the requested profile', () => {
  for (const event of ['workflow_dispatch', 'workflow_call', 'schedule']) {
    assert.equal(changedPaths(event, {}, { git: () => assert.fail('not a diff event') }), null);
    for (const profile of ['pr', 'merge', 'daily', 'release']) {
      const policy = route(event, profile, 'legacy', ['docs/guide.md']);
      assert.equal(policy.docs_only, false); assert.equal(policy.profile, profile); assert.equal(policy.backend, 'legacy');
    }
  }
  // Reusable workflows inherit the caller's event_name. The profile input is
  // always defaulted for dispatch/call, and absent for direct diff events.
  const enabled = jobs.policy.match(/CI_DIFF_ENABLED: \$\{\{([^]*?)\}\}/)[1];
  for (const event of ['pull_request', 'push', 'merge_group']) {
    for (const profile of ['', 'pr', 'merge', 'daily', 'release']) {
      assert.equal(eligible(enabled, {}, { event, inputs: { profile } }), false);
    }
    assert.equal(eligible(enabled, {}, { event, inputs: {} }), true);
    assert.equal(changedPaths(event, {}, { enabled: false, git: () => assert.fail('disabled diff') }), null);
  }
  const call = workflow.split('  workflow_call:\n')[1].split('\njobs:\n')[0];
  assert.match(call, /profile:[^]*?default: pr/);
  assert.match(jobs.policy, /fetch-depth: 0/);
});

test('policy CLI fails closed on unreadable events and disables inherited caller diffs', t => {
  const f = fixture(t);
  f.write('docs/guide.md', 'updated'); const head = f.commit();
  const eventPath = join(f.cwd, 'event.json');
  writeFileSync(eventPath, JSON.stringify(payload('push', f.base, head)));
  for (const [name, enabled, event, expected] of [
    ['docs', 'true', eventPath, 'true'], ['call', 'false', eventPath, 'false'],
    ['unreadable', 'true', join(f.cwd, 'missing.json'), 'false'],
  ]) {
    const output = join(f.cwd, `${name}.output`);
    const result = spawnSync(process.execPath, [join(repository, '.ci/tier-policy.mjs')], { cwd: f.cwd, encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output,
        CI_REQUESTED_PROFILE: 'merge', CI_DIFF_ENABLED: enabled } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(output, 'utf8'), new RegExp(`docs_only=${expected}\\n`));
  }
});

test('documentation-only PR, push and queue run docs and merge-gate without heavy jobs or artifacts', () => {
  const l1Steps = jobs.l1.split(/\n      - /);
  const full = l1Steps.find(step => step.includes('run: pnpm ci:l1'));
  const docs = l1Steps.find(step => step.includes('pnpm docs:check'));
  assert.ok(full); assert.ok(docs);
  assert.match(docs, /pnpm install --frozen-lockfile/);
  const artifacts = jobs['merge-gate'].split(/\n      - /).filter(step => /download-artifact|mocked-report|upload-artifact/.test(step));
  assert.equal(artifacts.length, 4);
  for (const event of ['pull_request', 'push', 'merge_group']) {
    const needs = selection(event, ['docs/en/guide.md']);
    for (const name of ['policy', 'l1', 'merge-gate']) assert.equal(needs[name].result, 'success', `${event}: ${name}`);
    for (const name of unaffected) assert.equal(needs[name].result, 'skipped', `${event}: ${name}`);
    assert.deepEqual(gate(needs.policy.outputs.profile, needs), []);
    assert.equal(eligible(condition(docs), needs), true);
    assert.equal(eligible(condition(full), needs), false);
    for (const step of artifacts) assert.equal(eligible(condition(step), needs), false);
    for (const name of unaffected.filter(name => name !== 'coverage')) {
      for (const result of ['success', 'failure', 'cancelled', undefined]) {
        assert.ok(gate(needs.policy.outputs.profile, { ...needs, [name]: { result } }).length);
      }
    }
    for (const name of ['policy', 'l1']) {
      for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
        assert.ok(gate(needs.policy.outputs.profile, { ...needs, [name]: { ...needs[name], result } }).length);
      }
    }
  }
  const gateStep = jobs['merge-gate'].split(/\n      - /).find(step => step.includes('node .ci/tier-policy.mjs gate'));
  assert.match(gateStep, /if: always\(\)/);
  assert.match(gateStep, /CI_JOB_RESULTS: \$\{\{ toJSON\(needs\) \}\}/);
  assert.match(jobs['merge-gate'], /name: merge-gate\n/);
  const upload = artifacts.find(step => step.includes('upload-artifact'));
  const normal = selection('pull_request', ['services/api/src/main.ts']);
  assert.equal(eligible(condition(upload), normal, { success: false }), true, 'failed tests must still upload evidence');
  for (const step of artifacts.filter(step => step !== upload)) {
    assert.equal(eligible(condition(step), normal), true, 'normal profiles must retain E2E artifact accounting');
  }
});

test('documentation-only drafts still check docs and keep the heavy jobs and gate skipped', () => {
  const needs = selection('pull_request', ['docs/guide.md'], { draft: true });
  assert.equal(needs.l1.result, 'success');
  const docs = jobs.l1.split(/\n      - /).find(step => step.includes('pnpm docs:check'));
  assert.equal(eligible(condition(docs), needs, { draft: true }), true);
  for (const name of [...unaffected, 'merge-gate']) assert.equal(needs[name].result, 'skipped', name);
});

test('mixed, non-documentation and unknown diffs preserve all existing profile selections and gate rules', () => {
  for (const event of ['pull_request', 'push', 'merge_group', 'workflow_dispatch', 'workflow_call']) {
    for (const profile of ['pr', 'merge', 'daily', 'release']) {
      for (const paths of [null, ['docs/guide.md', 'services/api/src/main.ts'], ['skills/guide.md']]) {
        const needs = selection(event, paths, { profile });
        const selectedProfile = needs.policy.outputs.profile;
        for (const name of ['l1', 'ut', 'st', 'e2e-plan', 'e2e', 'coverage', 'merge-gate']) assert.equal(needs[name].result, 'success', `${event}: ${name}`);
        for (const name of ['binary', 'docker']) assert.equal(needs[name].result, selectedProfile === 'pr' ? 'skipped' : 'success');
        assert.equal(needs['real-merge'].result, selectedProfile === 'merge' ? 'success' : 'skipped');
        assert.equal(needs['real-scheduled'].result, ['daily', 'release'].includes(selectedProfile) ? 'success' : 'skipped');
        assert.deepEqual(gate(selectedProfile, needs), []);
        for (const name of ['ut', 'st', 'e2e-plan', 'e2e']) {
          assert.ok(gate(selectedProfile, { ...needs, [name]: { result: 'skipped' } }).length, `${event}: ${name}`);
        }
      }
    }
  }
});
