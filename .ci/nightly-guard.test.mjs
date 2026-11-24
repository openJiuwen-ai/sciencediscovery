// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTest } from '../test/support/tagged/compat.mjs';

const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });
const nightly = readFileSync(new URL('../.github/workflows/nightly.yml', import.meta.url), 'utf8');

/** The text of one job in a workflow, by job id. */
function jobBlock(workflow, name) {
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
  const block = jobs.split(/\n(?=  [\w-]+:\n)/).slice(1).find((candidate) => candidate.startsWith(`  ${name}:\n`));
  assert.ok(block, `${name} is missing from nightly.yml`);
  return block;
}

/** The contents of the first `key: |` scalar in a job, dedented. */
function blockScalar(block, key) {
  const lines = block.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\s+${key}: \\|\\s*$`).test(line));
  assert.notEqual(start, -1, `${key} literal block is missing`);
  const base = lines[start].search(/\S/);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if (line.search(/\S/) <= base) break;
    body.push(line.slice(base + 2));
  }
  return `${body.join('\n').replace(/\n+$/, '')}\n`;
}

const guardJob = jobBlock(nightly, 'guard');
const guardScript = blockScalar(guardJob, 'run');

const dateStub = `#!/usr/bin/env bash
set -euo pipefail
today="\${STUB_TODAY:?}"
yesterday="\${STUB_YESTERDAY:?}"
today_boundary="\${today}T16:00:00Z"
yesterday_boundary="\${yesterday}T16:00:00Z"
if [[ "$*" == "-u +%s" ]]; then
  printf '%s\\n' "\${STUB_NOW_EPOCH:?}"
elif [[ "$*" == "-u -d 16:00 today +%s" ]]; then
  /bin/date -u -d "$today_boundary" +%s
elif [[ "$*" == "-u -d 16:00 yesterday +%s" ]]; then
  /bin/date -u -d "$yesterday_boundary" +%s
elif [[ "\${3-}" == @* && "\${4-}" == "+%Y-%m-%dT%H:%M:%SZ" ]]; then
  epoch="\${3#@}"
  if [[ "$epoch" == "$(/bin/date -u -d "$today_boundary" +%s)" ]]; then
    printf '%s\\n' "$today_boundary"
  elif [[ "$epoch" == "$(/bin/date -u -d "$yesterday_boundary" +%s)" ]]; then
    printf '%s\\n' "$yesterday_boundary"
  else
    echo "unexpected boundary epoch: $epoch" >&2
    exit 2
  fi
else
  echo "unexpected date call: $*" >&2
  exit 2
fi
`;

const ghStub = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" > "\${STUB_GH_LOG:?}"
case "\${STUB_GH_MODE:?}" in
  match) printf '1\\n' ;;
  none) printf '0\\n' ;;
  fail) echo "gh: HTTP 500" >&2; exit 1 ;;
  *) echo "unknown stub mode" >&2; exit 2 ;;
esac
`;

/**
 * Run the guard job's actual shell with a fixed clock and a stubbed `gh`.
 * Only `gh` and the boundary clock are replaced; the workflow text is the
 * script that runs here.
 */
function runGuard(t, { event, mode, now = '2026-11-19T20:00:00Z', refName = 'main' }) {
  const root = mkdtempSync(join(tmpdir(), 'nightly-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'date'), dateStub, { mode: 0o755 });
  writeFileSync(join(bin, 'gh'), ghStub, { mode: 0o755 });
  const script = join(root, 'guard.sh');
  writeFileSync(script, guardScript);
  const output = join(root, 'output.txt');
  const ghLog = join(root, 'gh-args.txt');
  writeFileSync(output, '');
  const today = new Date(`${now.slice(0, 10)}T00:00:00Z`);
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const result = spawnSync('bash', ['-e', script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_EVENT_NAME: event,
      GITHUB_REF_NAME: refName,
      GITHUB_REPOSITORY: 'openJiuwen-ai/sciencediscovery',
      GITHUB_OUTPUT: output,
      STUB_GH_MODE: mode,
      STUB_GH_LOG: ghLog,
      STUB_NOW_EPOCH: String(Date.parse(now) / 1000),
      STUB_TODAY: today.toISOString().slice(0, 10),
      STUB_YESTERDAY: yesterday.toISOString().slice(0, 10),
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  return {
    result,
    output: readFileSync(output, 'utf8'),
    ghArgs: existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim() : '',
  };
}

/** The value that follows a flag in the recorded `gh` argv. */
function ghFlag(ghArgs, flag) {
  const argv = ghArgs.split(/\s+/);
  const index = argv.indexOf(flag);
  assert.notEqual(index, -1, `${flag} is missing from: ${ghArgs}`);
  assert.ok(index + 1 < argv.length, `${flag} has no value in: ${ghArgs}`);
  return argv[index + 1];
}

test('a scheduled fallback runs when no successful dispatch exists since 16:00 UTC', (t) => {
  const { result, output, ghArgs } = runGuard(t, { event: 'schedule', mode: 'none', now: '2026-11-19T20:00:00Z' });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.equal(output, 'run=true\n');
  assert.equal(ghFlag(ghArgs, '-b'), 'main');
  assert.match(ghArgs, /-w nightly\.yml/);
  assert.match(ghArgs, /-e workflow_dispatch/);
  assert.match(ghArgs, /-s success/);
  assert.match(ghArgs, /--created >=2026-11-19T16:00:00Z/);
  assert.match(ghArgs, /--limit 1/);
});

test('a scheduled fallback on another branch scopes the dispatch lookup to that ref', (t) => {
  const { result, output, ghArgs } = runGuard(t, {
    event: 'schedule',
    mode: 'none',
    now: '2026-11-19T20:00:00Z',
    refName: 'ci/l5-biomnibench-da',
  });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.equal(output, 'run=true\n');
  assert.equal(ghFlag(ghArgs, '-b'), 'ci/l5-biomnibench-da');
  assert.match(ghArgs, /-w nightly\.yml/);
  assert.match(ghArgs, /-e workflow_dispatch/);
  assert.match(ghArgs, /-s success/);
  assert.match(ghArgs, /--created >=2026-11-19T16:00:00Z/);
  assert.match(ghArgs, /--limit 1/);
});

test('a scheduled fallback is skipped after a successful dispatch at or after 16:00 UTC', (t) => {
  const { result, output } = runGuard(t, { event: 'schedule', mode: 'match', now: '2026-11-19T20:00:00Z' });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.equal(output, 'run=false\n');
});

test('a delayed run before 16:00 UTC looks back to yesterday 16:00 UTC', (t) => {
  const { result, output, ghArgs } = runGuard(t, { event: 'schedule', mode: 'none', now: '2026-11-19T10:00:00Z' });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.equal(output, 'run=true\n');
  assert.equal(ghFlag(ghArgs, '-b'), 'main');
  assert.match(ghArgs, /--created >=2026-11-18T16:00:00Z/);
});

test('a failed gh query fails the guard instead of defaulting to run=true', (t) => {
  const { result, output } = runGuard(t, { event: 'schedule', mode: 'fail' });
  assert.notEqual(result.status, 0);
  assert.equal(output, '');
  assert.match(result.stderr, /gh: HTTP 500/);
});

test('a workflow_dispatch always runs and never queries dispatch history', (t) => {
  const { result, output, ghArgs } = runGuard(t, { event: 'workflow_dispatch', mode: 'fail' });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.equal(output, 'run=true\n');
  assert.equal(ghArgs, '');
});

test('nightly keeps the cron fallback, dispatch and non-cancelling concurrency', () => {
  assert.match(nightly, /- cron: "0 16 \* \* \*"/);
  assert.match(nightly, /^on:\n  schedule:\n(?:.*\n)*?    - cron: "0 16 \* \* \*"\n  workflow_dispatch:/m);
  assert.match(nightly, /^permissions:\n  contents: read$/m);
  assert.match(nightly, /^concurrency:\n(?:  #.*\n)*  group: nightly-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false$/m);
});

test('the guard uses actions:read with the workflow token and no new secret', () => {
  assert.match(guardJob, /permissions:\n      actions: read\n      contents: read/);
  assert.match(guardJob, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(guardJob, /outputs:\n      run: \$\{\{ steps\.check\.outputs\.run \}\}/);
  assert.doesNotMatch(guardJob, /\$\{\{ secrets\.|secrets: inherit/);
  // The only broad credential is the existing reusable workflow's inherit.
  assert.doesNotMatch(nightly.replace('    secrets: inherit\n', ''), /\$\{\{ secrets\./);
});

test('stamp, gate and report keep their work and are skipped when the guard says no', () => {
  const stamp = jobBlock(nightly, 'stamp');
  const gate = jobBlock(nightly, 'gate');
  const report = jobBlock(nightly, 'report');
  assert.match(stamp, /needs: guard\n    if: needs\.guard\.outputs\.run == 'true'/);
  assert.match(stamp, /date=\$\(TZ=Asia\/Shanghai date \+%Y%m%d\)/);
  assert.match(stamp, /version=nightly-\$\{date\}-\$\{GITHUB_SHA::7\}/);
  assert.match(gate, /needs: \[guard, stamp\]\n    if: needs\.guard\.outputs\.run == 'true'/);
  assert.match(gate, /profile: daily/);
  assert.match(gate, /release-version: \$\{\{ needs\.stamp\.outputs\.version \}\}/);
  assert.match(report, /needs: \[guard, stamp, gate\]\n    if: always\(\) && needs\.guard\.outputs\.run == 'true'/);
  // The report's own pass/fail rule is unchanged once it does run.
  assert.match(report, /\[\[ "\$\{RESULT\}" == "success" \]\]/);
});
