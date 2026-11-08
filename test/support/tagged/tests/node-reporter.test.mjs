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
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import reporter from '../node-reporter.mjs';

const reporterPath = fileURLToPath(new URL('../node-reporter.mjs', import.meta.url));

test('a real node:test after hook failure retains its original filesystem error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'node-reporter-hook-'));
  try {
    const fixture = join(root, 'hook.test.mjs');
    await writeFile(fixture, `import test from 'node:test';
      test('cleanup fixture', context => {
        context.after(() => { throw Object.assign(new Error('directory still has pending writes'), { code: 'ENOTEMPTY' }); });
      });`);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter', reporterPath, fixture], { encoding: 'utf8', timeout: 10_000, env });
    assert.equal(result.status, 1, result.stderr);
    const failure = result.stdout.trim().split('\n').map(line => JSON.parse(line)).find(event => event.type === 'test:fail' && event.name === 'cleanup fixture');
    assert.equal(failure.message, 'failed running after hook');
    assert.equal(failure.error.cause.code, 'ENOTEMPTY');
    assert.equal(failure.error.cause.message, 'directory still has pending writes');
    assert.match(failure.error.cause.stack, /hook.test.mjs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function reportError(error) {
  async function* events() {
    yield { type: 'test:fail', data: { name: 'fixture', details: { type: 'test', error } } };
  }
  const lines = [];
  for await (const line of reporter(events())) lines.push(JSON.parse(line));
  return lines[0].error;
}

test('aggregate failures retain each cause and circular causes stay bounded', async () => {
  const circular = new Error('circular cleanup'); circular.cause = circular;
  const evidence = await reportError(new AggregateError([new Error('API disposal failed'), circular], 'cleanup failures'));
  assert.equal(evidence.errors[0].message, 'API disposal failed');
  assert.equal(evidence.errors[1].cause.message, '[nested error omitted]');
});
