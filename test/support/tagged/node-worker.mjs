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

import * as native from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectNode } from './node-collect.mjs';
import { registeredRoots } from './node.mjs';
import { digest, canonical, validatePlan } from './plan.mjs';
import { inTest, currentTest } from './context.mjs';
import { hostPlatform, hostArch } from './environment.mjs';

const request = JSON.parse(readFileSync(process.env.SCIENCE_TAG_RUN_REQUEST, 'utf8'));
validatePlan(request.plan);
const expected = new Map(request.plan.entries.map(e => [e.id, e]));
if (expected.size !== request.plan.entries.length) throw new Error('Worker accepts one target per test ID');
const current = await collectNode(request.root, request.files);
for (const [id, entry] of expected) {
  const now = current.find(c => c.id === id);
  if (!now || now.sourceHash !== entry.sourceHash || canonical(now.tags) !== canonical(entry.tags)) {
    throw new Error(`COLLECTION_DRIFT: ${id}`);
  }
}
const containsSelected = node => node.kind === 'test' ? expected.has(node.descriptor.id) : node.children.some(containsSelected);
function register(node) {
  if (!containsSelected(node)) return;
  if (node.kind === 'suite') {
    native.describe(node.name, { concurrency: false }, () => {
      for (const h of node.hooks) native[h.name](h.fn, h.options);
      node.children.forEach(register);
    });
    return;
  }
  const entry = expected.get(node.descriptor.id);
  const token = digest(entry.key);
  const name = `${node.name} [science:${token}]`;
  native.test(name, { timeout: node.options.timeout ?? request.timeoutMs ?? 300_000 }, async context => {
    assert.equal(node.descriptor.forbiddenSkip, undefined, 'skip/todo declarations are forbidden');
    const actualTarget = { os: hostPlatform(process.platform), arch: hostArch(process.arch) };
    assert.deepEqual(actualTarget, entry.target, 'Execution host does not match the frozen plan');
    const wrapped = new Proxy(context, { get(target, key) {
      if (['skip', 'todo', 'test'].includes(key)) return () => { throw new Error(`Forbidden runtime ${String(key)}: selected tests cannot skip or create unplanned subtests`); };
      if (key === 'target') return Object.freeze({ ...entry.target });
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await inTest(entry, async () => {
      await node.fn(wrapped);
      if (entry.tags.includes('judge:llm')) assert.ok(currentTest().judgeCalls > 0, 'judge:llm test did not call llmAssert');
      for (const evidence of currentTest().evidence) context.diagnostic(`LLM_EVIDENCE ${JSON.stringify(evidence)}`);
    });
  });
}
registeredRoots().forEach(register);
