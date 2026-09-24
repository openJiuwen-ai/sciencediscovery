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
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, execute, discoverFiles } from '../coordinator.mjs';
import { createPlan } from '../plan.mjs';
import { hostPlatform, hostArch } from '../environment.mjs';
const adapter = new URL('../node.mjs', import.meta.url).href;
const target = { os: hostPlatform(process.platform), arch: hostArch(process.arch) };
const tags = ['category:ut', 'os:linux', 'os:macos', 'os:windows', 'arch:amd64', 'arch:arm64', 'npu:none', 'model:none', 'judge:none'];
const header = `import assert from 'node:assert/strict';\nimport { createTest } from '${adapter}';\nconst {test,describe,before,after}=createTest(import.meta.url, { tags: ${JSON.stringify(tags)} });\n`;
const pyHeader = `import pytest\npytestmark = pytest.mark.science_tags(category='ut', os=('linux','macos','windows'), arch=('amd64','arm64'), npu='none', model='none', judge='none')\n`;
function fixture(t, filename, source) {
  const root = mkdtempSync(join(tmpdir(), 'science-tagged-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(dirname(join(root, filename)), { recursive: true });
  writeFileSync(join(root, filename), source);
  return { root, files: [filename], outputDir: join(root, 'output'), python: process.env.SCIENCE_TEST_PYTHON ?? 'python3' };
}
const makePlan = scope => createPlan(collect(scope), { revision: 'test-fixture', targets: [target] });

test('native Node executes exact selected identities without runtime skips', async t => {
  const scope = fixture(t, 'one.test.mjs', header + `test('one',()=>assert.equal(1+1,2));\ndescribe('nested',()=>{ test('two',()=>assert.ok(true)); });\n`);
  const plan = makePlan(scope);
  assert.equal(plan.entries.length, 2);
  const result = await execute({ ...scope, plan });
  assert.deepEqual(result.problems, []);
  assert.equal(result.passed, 2);
});
test('native Node selection does not register unselected tests', async t => {
  const scope = fixture(t, 'one.test.mjs', header + `test('one',()=>assert.ok(true));\ntest('not selected',{tags:['category:st']},()=>{throw new Error('must not execute')});\n`);
  const plan = createPlan(collect(scope), { revision: 'test', selector: 'category:ut', targets: [target] });
  const result = await execute({ ...scope, plan });
  assert.equal(result.exitCode, 0);
  assert.equal(result.reported, 1);
  assert.equal(result.skipped, 0);
});
test('native Node runtime skip and todo declarations cannot pass', async t => {
  for (const body of [`test('skip', t=>t.skip());`, `test.skip('skip',()=>{});`, `test.todo('todo',()=>{});`]) {
    const scope = fixture(t, 'one.test.mjs', header + body);
    const result = await execute({ ...scope, plan: makePlan(scope) });
    assert.equal(result.status, 'FAIL');
  }
});
test('native Node teardown failure fails an otherwise passing selected test', async t => {
  const scope = fixture(t, 'one.test.mjs', header + `after(()=>{throw new Error('cleanup failed')});\ntest('one',()=>{});`);
  assert.equal((await execute({ ...scope, plan: makePlan(scope) })).status, 'FAIL');
});
test('native Node rejects unplanned dynamic subtests', async t => {
  const scope = fixture(t, 'one.test.mjs', header + `test('one',async t=>{await t.test('hidden',()=>{});});`);
  assert.equal((await execute({ ...scope, plan: makePlan(scope) })).status, 'FAIL');
});
test('collection never invokes test bodies or runtime hooks', t => {
  const scope = fixture(t, 'one.test.mjs', header + `before(()=>{throw new Error('must not run at collection')});\ntest('one',()=>{throw new Error('must not run at collection')});`);
  assert.equal(makePlan(scope).entries.length, 1);
});
test('environment-dependent source registration fails, rather than shrinking the plan', t => {
  const scope = fixture(t, 'one.test.mjs', header + `if(process.env.HAS_NPU) test('one',()=>{});`);
  assert.throws(() => collect(scope), /COLLECTION_FAILED/);
  assert.match(readFileSync(join(scope.outputDir, 'node-collect.log'), 'utf8'), /DYNAMIC_REGISTRATION/);
});
test('empty Node modules and focused tests fail collection', t => {
  for (const body of ['', `test.only('one',()=>{});`]) {
    const scope = fixture(t, 'one.test.mjs', header + body);
    assert.throws(() => collect(scope), /COLLECTION_FAILED/);
  }
});
test('source changes after planning fail exact execution reconciliation', async t => {
  const scope = fixture(t, 'one.test.mjs', header + `test('one',()=>{});`);
  const plan = makePlan(scope);
  writeFileSync(join(scope.root, 'one.test.mjs'), header + `test('two',()=>{});`);
  const result = await execute({ ...scope, plan });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.problems.some(p=>p.startsWith('NOT_RUN')));
});
test('native pytest executes and reports stable framework-expanded IDs', async t => {
  const scope = fixture(t, 'test_one.py', pyHeader + `@pytest.mark.parametrize('value', [1,2], ids=['first','second'])\ndef test_one(value):\n    assert value > 0\n`);
  const plan = makePlan(scope);
  assert.equal(plan.entries.length, 2);
  assert.ok(plan.entries.some(e=>e.id.includes('[second]')));
  const result = await execute({ ...scope, plan });
  if (result.status !== 'PASS') console.log(readFileSync(join(scope.outputDir,'worker-1.log'),'utf8'));
  assert.deepEqual(result.problems, []);
  assert.equal(result.passed, 2);
});
test("pytest reads the project's own config, not the science root's", async t => {
  // Laid out like services/<name>/: the config sits below the root the harness
  // is given. The conftest declares `asyncio_mode` as pytest-asyncio does, so
  // the test can read back what the project set.
  const scope = fixture(t, 'project/tests/test_one.py', pyHeader + `def test_one(request):\n    assert request.config.getini('asyncio_mode') == 'auto'\n`);
  writeFileSync(join(scope.root, 'project', 'pyproject.toml'), '[tool.pytest.ini_options]\nasyncio_mode = "auto"\n');
  writeFileSync(join(scope.root, 'project', 'conftest.py'), `def pytest_addoption(parser):\n    parser.addini('asyncio_mode', 'default mode for async tests', default='strict')\n`);
  const result = await execute({ ...scope, plan: makePlan(scope) });
  if (result.status !== 'PASS') console.log(readFileSync(join(scope.outputDir, 'worker-1.log'), 'utf8'));
  assert.deepEqual(result.problems, []);
  assert.equal(result.passed, 1);
});
test('native pytest runtime skip, skip markers and xfail are failures', async t => {
  for (const body of [
    `def test_one():\n    pytest.skip('missing hardware')\n`,
    `@pytest.mark.skip(reason='missing hardware')\ndef test_one():\n    assert True\n`,
    `@pytest.mark.xfail(reason='known bug')\ndef test_one():\n    assert False\n`,
  ]) {
    const scope = fixture(t, 'test_one.py', pyHeader + body);
    const result = await execute({ ...scope, plan: makePlan(scope) });
    assert.equal(result.status, 'FAIL');
  }
});
test('pytest module metadata is mandatory and closed-value', t => {
  for (const source of ['def test_one():\n    assert True\n', pyHeader.replace("model='none'", "model='typo'") + 'def test_one():\n    assert True\n']) {
    const scope = fixture(t, 'test_one.py', source);
    assert.throws(() => collect(scope), /PYTHON_COLLECTION_FAILED/);
  }
});
test('Python collection cannot branch test registration on environment', t => {
  const scope = fixture(t, 'test_one.py', pyHeader + `import os\nif os.environ.get('HAS_NPU'):\n    def test_one():\n        assert True\n`);
  assert.throws(() => collect(scope), /PYTHON_COLLECTION_FAILED/);
});
test('missing execution platform fails after a fixed plan was written', async t => {
  const scope = fixture(t, 'one.test.mjs', header + `test('one',()=>{});`);
  const plan = createPlan(collect(scope), { revision: 'test', targets: [{ ...target, os: target.os === 'linux' ? 'macos' : 'linux' }] });
  const result = await execute({ ...scope, plan });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.reported, 0);
  assert.equal(JSON.parse(readFileSync(join(scope.outputDir,'plan.json'),'utf8')).digest, plan.digest);
});
test('unmigrated Playwright inputs fail explicitly, not silently disappear', t => {
  const scope = fixture(t, 'one.spec.ts', 'test("one",()=>{});');
  assert.throws(() => discoverFiles(scope.root, scope.files), /Playwright/);
});

test('late registrations from runtime helpers are rejected', async t => {
  const scope = fixture(t, 'one.test.mjs', header + `test('one',()=>{test('hidden',()=>{});});`);
  assert.equal((await execute({ ...scope, plan: makePlan(scope) })).status, 'FAIL');
});
test('class static blocks cannot hide environment-dependent registration', t => {
  const scope = fixture(t, 'one.test.mjs', header + `class Hidden { static { if(process.env.HAS_NPU) test('hidden',()=>{}); } }\ntest('one',()=>{});`);
  assert.throws(() => collect(scope), /COLLECTION_FAILED/);
});
test('Python process exit(0) cannot reuse a stale passing report', async t => {
  const scope = fixture(t, 'test_one.py', pyHeader + `import os\ndef test_one():\n    if os.environ.get('EARLY_EXIT') == '1':\n        os._exit(0)\n    assert True\n`);
  const plan = makePlan(scope);
  assert.equal((await execute({ ...scope, plan })).status, 'PASS');
  const later = await execute({ ...scope, plan, env: { ...process.env, EARLY_EXIT: '1' } });
  assert.equal(later.status, 'FAIL');
  assert.equal(later.reported, 0);
});
test('an empty Python source cannot hide behind another nonempty module', t => {
  const scope = fixture(t, 'test_one.py', pyHeader + `def test_one():\n    assert True\n`);
  writeFileSync(join(scope.root, 'test_empty.py'), pyHeader);
  assert.throws(() => collect({ ...scope, files: [...scope.files, 'test_empty.py'] }), /EMPTY_MODULE/);
});

test('Python custom decorators cannot dynamically erase a test', t => {
  const scope = fixture(t, 'test_one.py', pyHeader + `def hide(fn):\n    return None\n@hide\ndef test_one():\n    assert True\n`);
  assert.throws(() => collect(scope), /PYTHON_COLLECTION_FAILED/);
});
test('a declared live judge must actually be invoked in Node and Python', async t => {
  const env = { ...process.env, CI_ALLOW_REAL: '1', E2E_JUDGE_BASE_URL: 'https://not-contacted.invalid/v1', E2E_JUDGE_MODEL: 'test', E2E_JUDGE_TOKEN: 'TEST_ONLY' };
  const n = fixture(t, 'one.test.mjs', header.replace('"judge:none"', '"judge:llm"') + `test('one',()=>{});`);
  const p = fixture(t, 'test_one.py', pyHeader.replace("judge='none'", "judge='llm'") + `def test_one():\n    assert True\n`);
  for (const scope of [n,p]) assert.equal((await execute({ ...scope, plan: makePlan(scope), env })).status, 'FAIL');
});
