// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTest } from '../test/support/tagged/compat.mjs';
import { createPlan } from '../test/support/tagged/plan.mjs';
import { sharedCacheEnv } from '../test/support/tagged/shared.mjs';
import { HEAVY_MOCKED_SHARDS, buildMockedMatrix } from './mocked-matrix.mjs';
import { SELF_HOSTED_RUNNER, route } from './tier-policy.mjs';

const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(repository, '.github/workflows/ci.yml'), 'utf8').replaceAll('\r\n', '\n');
const jobs = Object.fromEntries(
  workflow.split('\njobs:\n')[1].split(/\n(?=  [\w-]+:\n)/).slice(1)
    .map(block => [block.match(/^  ([\w-]+):/)[1], block]),
);

const descriptor = (id, extra = []) => ({
  id,
  source: `test/${id}.spec.ts`,
  sourceHash: 'a'.repeat(64),
  runner: 'playwright',
  tags: ['category:e2e', 'os:linux', 'arch:amd64', 'model:mock', ...extra],
});

const fiveShardPlan = () => createPlan([
  descriptor('fresh', ['isolation:fresh']),
  descriptor('settings', ['isolation:global']),
  descriptor('journey', ['isolation:session']),
  descriptor('research', ['fixture:research']),
  descriptor('literature', ['fixture:literature']),
  descriptor('governed', ['fixture:governed']),
], {
  revision: 'candidate',
  profile: 'merge',
  targets: [{ os: 'linux', arch: 'amd64' }],
  execution: { backend: 'jiuwenswarm' },
});

test('only merge_group with explicit toggle routes UT to self-hosted runners', () => {
  const enabled = route('merge_group', 'pr', 'jiuwenswarm', null, 'linux-windows', {
    selfHostedMergeQueue: true,
  });
  assert.equal(enabled.profile, 'merge');
  assert.equal(enabled.self_hosted_merge_queue, true);
  assert.deepEqual(JSON.parse(enabled.ut_runner), [...SELF_HOSTED_RUNNER]);

  const disabled = route('merge_group', 'pr', 'jiuwenswarm', null, 'linux-windows', {
    selfHostedMergeQueue: false,
  });
  assert.equal(disabled.self_hosted_merge_queue, false);
  assert.equal(JSON.parse(disabled.ut_runner), 'ubuntu-latest');

  const defaultOff = route('merge_group');
  assert.equal(defaultOff.self_hosted_merge_queue, false);
  assert.equal(JSON.parse(defaultOff.ut_runner), 'ubuntu-latest');

  for (const event of ['pull_request', 'workflow_dispatch', 'workflow_call', 'schedule', 'push']) {
    for (const profile of ['pr', 'merge', 'daily', 'release', 'package']) {
      const policy = route(event, profile, 'jiuwenswarm', null, 'linux-windows', {
        selfHostedMergeQueue: true,
      });
      assert.equal(policy.self_hosted_merge_queue, false, `${event}/${profile}`);
      assert.equal(JSON.parse(policy.ut_runner), 'ubuntu-latest', `${event}/${profile}`);
    }
  }
});

test('mocked E2E matrix routes only the three heavy shards to self-hosted when enabled', () => {
  const plan = fiveShardPlan();
  const hosted = buildMockedMatrix(plan, { selfHostedMergeQueue: false });
  assert.equal(hosted.include.length, 5);
  for (const entry of hosted.include) {
    assert.equal(entry.runner, 'ubuntu-latest', entry.shard);
    assert.equal(entry.self_hosted, false, entry.shard);
  }

  const routed = buildMockedMatrix(plan, { selfHostedMergeQueue: true });
  assert.equal(routed.include.length, 5);
  const byShard = Object.fromEntries(routed.include.map(entry => [entry.shard, entry]));
  for (const shard of ['standard-config', 'standard-journeys', 'research']) {
    assert.ok(HEAVY_MOCKED_SHARDS.has(shard), shard);
    assert.deepEqual(byShard[shard].runner, [...SELF_HOSTED_RUNNER], shard);
    assert.equal(byShard[shard].self_hosted, true, shard);
  }
  for (const shard of ['governed', 'literature']) {
    assert.ok(!HEAVY_MOCKED_SHARDS.has(shard), shard);
    assert.equal(byShard[shard].runner, 'ubuntu-latest', shard);
    assert.equal(byShard[shard].self_hosted, false, shard);
  }
});

test('tier-policy and mocked-matrix CLIs propagate CI_SELF_HOSTED_MERGE_QUEUE accurately', t => {
  const parent = join(repository, '.tmp', 'self-hosted-merge-queue-tests');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const eventPath = join(root, 'event.json');
  writeFileSync(eventPath, JSON.stringify({}));
  for (const [name, eventName, flag, expectedSelfHosted, expectedUtRunner] of [
    ['mg-on', 'merge_group', 'true', 'true', JSON.stringify(SELF_HOSTED_RUNNER)],
    ['mg-off', 'merge_group', 'false', 'false', '"ubuntu-latest"'],
    ['dispatch-on', 'workflow_dispatch', 'true', 'false', '"ubuntu-latest"'],
  ]) {
    const out = join(root, `${name}.out`);
    const result = spawnSync(process.execPath, [join(repository, '.ci/tier-policy.mjs')], {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: out,
        CI_REQUESTED_PROFILE: 'merge',
        CI_DIFF_ENABLED: 'false',
        CI_SELF_HOSTED_MERGE_QUEUE: flag,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(out, 'utf8');
    assert.match(text, new RegExp(`^self_hosted_merge_queue=${expectedSelfHosted}$`, 'm'));
    assert.ok(text.includes(`ut_runner=${expectedUtRunner}\n`), text);
  }

  const planPath = join(root, 'plan.json');
  writeFileSync(planPath, JSON.stringify(fiveShardPlan()));
  for (const [name, flag, expectedSelfHosted] of [
    ['matrix-on', 'true', 3],
    ['matrix-off', 'false', 0],
  ]) {
    const out = join(root, `${name}.out`);
    const result = spawnSync(process.execPath, [join(repository, '.ci/mocked-matrix.mjs'), planPath], {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: out,
        CI_SELF_HOSTED_MERGE_QUEUE: flag,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const line = readFileSync(out, 'utf8').trim();
    assert.ok(line.startsWith('matrix='), line);
    const matrix = JSON.parse(line.slice('matrix='.length));
    assert.equal(matrix.include.filter(entry => entry.self_hosted).length, expectedSelfHosted);
  }
});

test('ci.yml wires merge-queue self-hosted routing, cache toggles and idempotent bwrap check', () => {
  assert.match(jobs.policy, /self_hosted_merge_queue: \$\{\{ steps\.policy\.outputs\.self_hosted_merge_queue \}\}/);
  assert.match(jobs.policy, /ut_runner: \$\{\{ steps\.policy\.outputs\.ut_runner \}\}/);
  assert.match(jobs.policy, /CI_SELF_HOSTED_MERGE_QUEUE: \$\{\{ vars\.CI_SELF_HOSTED_MERGE_QUEUE \}\}/);

  assert.match(jobs['e2e-plan'], /CI_SELF_HOSTED_MERGE_QUEUE: \$\{\{ needs\.policy\.outputs\.self_hosted_merge_queue \}\}/);
  assert.doesNotMatch(jobs['e2e-plan'], /vars\.CI_SELF_HOSTED_MERGE_QUEUE/);

  assert.match(jobs.ut, /runs-on: \$\{\{ fromJSON\(needs\.policy\.outputs\.ut_runner\) \}\}/);
  assert.match(jobs.ut, /cache: \$\{\{ needs\.policy\.outputs\.self_hosted_merge_queue != 'true' && 'pnpm' \|\| '' \}\}/);
  assert.match(jobs.ut, /enable-cache: \$\{\{ needs\.policy\.outputs\.self_hosted_merge_queue != 'true' \}\}/);
  assert.match(jobs.ut, /if ! bwrap --unshare-user --ro-bind \/ \/ --dev \/dev true 2>\/dev\/null; then/);
  assert.match(jobs.ut, /name: Cache the JiuwenSwarm install\n\s+if: \$\{\{ needs\.policy\.outputs\.self_hosted_merge_queue != 'true' \}\}/);
  assert.match(jobs.ut, /name: Use local JiuwenSwarm cache\n\s+if: \$\{\{ needs\.policy\.outputs\.self_hosted_merge_queue == 'true' \}\}[\s\S]*?run: bash \.ci\/use-local-swarm-cache\.sh/);

  assert.match(jobs.e2e, /max-parallel: 5/);
  assert.match(jobs.e2e, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.match(jobs.e2e, /cache: \$\{\{ !matrix\.self_hosted && 'pnpm' \|\| '' \}\}/);
  assert.match(jobs.e2e, /enable-cache: \$\{\{ !matrix\.self_hosted \}\}/);
  assert.match(jobs.e2e, /if ! bwrap --unshare-user --ro-bind \/ \/ --dev \/dev true 2>\/dev\/null; then/);
  assert.match(jobs.e2e, /name: Cache the pinned Chromium\n\s+if: \$\{\{ !matrix\.self_hosted \}\}/);
  assert.match(jobs.e2e, /name: Cache the JiuwenSwarm install\n\s+if: \$\{\{ !matrix\.self_hosted \}\}/);
  assert.match(jobs.e2e, /name: Use local JiuwenSwarm cache\n\s+if: \$\{\{ matrix\.self_hosted \}\}[\s\S]*?run: bash \.ci\/use-local-swarm-cache\.sh/);

  for (const jobName of ['l1', 'e2e-plan', 'st', 'desktop-mocked', 'docker']) {
    assert.match(jobs[jobName], /runs-on: ubuntu-latest/, jobName);
  }
  assert.match(jobs.binary, /runner: ubuntu-latest/);
  assert.match(jobs.binary, /runner: ubuntu-24\.04-arm/);
  assert.doesNotMatch(jobs.binary, /self-hosted/);
});

test('sharedCacheEnv falls back to workspace caches when unset and honors container cache env vars', () => {
  const fallback = sharedCacheEnv({}, '/workspace');
  assert.deepEqual(fallback, {
    UV_CACHE_DIR: '/workspace/.tmp/cache/uv',
    UV_PYTHON_INSTALL_DIR: '/workspace/.tmp/python',
    npm_config_cache: '/workspace/.tmp/cache/npm',
    PLAYWRIGHT_BROWSERS_PATH: '/workspace/.e2e/browsers',
  });

  const container = sharedCacheEnv({
    UV_CACHE_DIR: '/ci-cache/uv-cache',
    UV_PYTHON_INSTALL_DIR: '/opt/uv-python',
    npm_config_cache: '/ci-cache/npm-cache',
    PLAYWRIGHT_BROWSERS_PATH: '/ci-cache/ms-playwright',
  }, '/workspace');
  assert.deepEqual(container, {
    UV_CACHE_DIR: '/ci-cache/uv-cache',
    UV_PYTHON_INSTALL_DIR: '/opt/uv-python',
    npm_config_cache: '/ci-cache/npm-cache',
    PLAYWRIGHT_BROWSERS_PATH: '/ci-cache/ms-playwright',
  });
});

test('use-local-swarm-cache.sh populates once, reuses warm cache, cleans failures and rejects bad keys', t => {
  const parent = join(repository, '.tmp', 'self-hosted-merge-queue-tests');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'swarm-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, '.ci'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(join(repository, '.ci/use-local-swarm-cache.sh'), join(root, '.ci/use-local-swarm-cache.sh'));
  chmodSync(join(root, '.ci/use-local-swarm-cache.sh'), 0o755);

  const callsFile = join(root, 'setup-calls.log');
  const uvCallsFile = join(root, 'uv-calls.log');
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'uv'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${uvCallsFile}"
`, { mode: 0o755 });
  const stubScript = join(root, 'scripts/jiuwenswarm.sh');
  writeFileSync(stubScript, `#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s|%s\\n' "$1" "\${SCIENCE_AGENT_JIUWENSWARM_OVERRIDES:-}" "\${JIUWENSWARM_SRC:-}" >> "${callsFile}"
if [[ "\${FAIL_STUB:-0}" == "1" ]]; then
  mkdir -p "$JIUWENSWARM_SRC/.git"
  printf 'partial' > "$JIUWENSWARM_SRC/partial.txt"
  exit 1
fi
mkdir -p "$JIUWENSWARM_SRC/.git" "$JIUWENSWARM_SRC/.venv/bin"
cat <<'EOF' > "$JIUWENSWARM_SRC/.venv/bin/jiuwenswarm-start"
#!/usr/bin/env bash
exit 0
EOF
cat <<'EOF' > "$JIUWENSWARM_SRC/.venv/bin/python"
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$JIUWENSWARM_SRC/.venv/bin/jiuwenswarm-start" "$JIUWENSWARM_SRC/.venv/bin/python"
`, { mode: 0o755 });

  const cacheDir = join(root, 'ci-cache');
  const expectedTarget = join(cacheDir, 'jiuwenswarm', 'test-key-01', 'src');
  const testPath = `${binDir}:${process.env.PATH ?? ''}`;

  // Cold cache populates target, removes .git, pre-installs pytest under lock,
  // creates .ready, and exports only JIUWENSWARM_SRC.
  const envCold = join(root, 'github-env-cold');
  writeFileSync(envCold, '');
  const cold = spawnSync('bash', [join(root, '.ci/use-local-swarm-cache.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: testPath,
      SD_CI_CACHE_DIR: cacheDir,
      CI_SWARM_CACHE_KEY: 'test-key-01',
      GITHUB_ENV: envCold,
    },
  });
  assert.equal(cold.status, 0, cold.stderr);
  assert.equal(readFileSync(callsFile, 'utf8').trim(), `setup|1|${expectedTarget}`);
  assert.equal(
    readFileSync(uvCallsFile, 'utf8').trim(),
    `pip install --python ${expectedTarget}/.venv/bin/python pytest>=8.3.5`,
  );
  assert.equal(existsSync(join(expectedTarget, '.git')), false);
  assert.equal(existsSync(join(expectedTarget, '.venv/bin/jiuwenswarm-start')), true);
  assert.equal(existsSync(join(cacheDir, 'jiuwenswarm', 'test-key-01', '.ready')), true);
  assert.equal(readFileSync(envCold, 'utf8'), `JIUWENSWARM_SRC=${expectedTarget}\n`);

  // Warm cache hits fast path without re-running setup or uv pip install.
  const envWarm = join(root, 'github-env-warm');
  writeFileSync(envWarm, '');
  const warm = spawnSync('bash', [join(root, '.ci/use-local-swarm-cache.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: testPath,
      SD_CI_CACHE_DIR: cacheDir,
      CI_SWARM_CACHE_KEY: 'test-key-01',
      GITHUB_ENV: envWarm,
    },
  });
  assert.equal(warm.status, 0, warm.stderr);
  assert.equal(readFileSync(callsFile, 'utf8').trim().split('\n').length, 1);
  assert.equal(readFileSync(uvCallsFile, 'utf8').trim().split('\n').length, 1);
  assert.equal(readFileSync(envWarm, 'utf8'), `JIUWENSWARM_SRC=${expectedTarget}\n`);

  // Failed cold build cleans partial target and leaves GITHUB_ENV untouched.
  const envFail = join(root, 'github-env-fail');
  writeFileSync(envFail, '');
  const failed = spawnSync('bash', [join(root, '.ci/use-local-swarm-cache.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SD_CI_CACHE_DIR: cacheDir,
      CI_SWARM_CACHE_KEY: 'test-key-fail',
      FAIL_STUB: '1',
      GITHUB_ENV: envFail,
    },
  });
  assert.notEqual(failed.status, 0);
  assert.equal(existsSync(join(cacheDir, 'jiuwenswarm', 'test-key-fail', 'src')), false);
  assert.equal(existsSync(join(cacheDir, 'jiuwenswarm', 'test-key-fail', '.ready')), false);
  assert.equal(readFileSync(envFail, 'utf8'), '');

  // Path traversal keys are rejected before touching the cache directory.
  const badKey = spawnSync('bash', [join(root, '.ci/use-local-swarm-cache.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SD_CI_CACHE_DIR: cacheDir,
      CI_SWARM_CACHE_KEY: '../escape',
    },
  });
  assert.notEqual(badKey.status, 0);
  assert.match(badKey.stderr, /Invalid CI_SWARM_CACHE_KEY/);
});
