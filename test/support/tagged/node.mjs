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

// Thin declaration adapter for node:test on the repository's Node 22 baseline.
// Framework execution stays in node:test; this module never executes test bodies.
import { fileURLToPath } from 'node:url';
import { relative, resolve, isAbsolute } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { normalizeTags, inheritTags } from './tags.mjs';
import { fileDigest } from './plan.mjs';

const slot = Symbol.for('sciencediscovery.tagged.registry');
export function beginCollection(root) {
  globalThis[slot] = { root: realpathSync(root), roots: [], ids: new Set() };
}
export function endCollection() { globalThis[slot].closed = true; }
export function registeredRoots() { return globalThis[slot]?.roots ?? []; }
export function descriptors() {
  const all = [];
  const visit = node => {
    if (node.kind === 'test') all.push(node.descriptor);
    else node.children.forEach(visit);
  };
  registeredRoots().forEach(visit);
  return all;
}
export function createTest(file, { tags } = {}) {
  const state = globalThis[slot];
  if (!state) throw new Error('Use test:tagged:list/run; direct node --test would not enforce the frozen plan');
  const absolute = realpathSync(file instanceof URL || String(file).startsWith('file:') ? fileURLToPath(file) : resolve(file));
  const path = relative(state.root, absolute).replaceAll('\\', '/');
  if (!path || path === '..' || path.startsWith('../') || isAbsolute(path)) throw new Error('Test source is outside the repository');
  const sourceHash = fileDigest(readFileSync(absolute));
  const initialTags = normalizeTags(tags);
  const root = { kind: 'suite', name: path, children: [], hooks: [], tags: initialTags, options: {} };
  state.roots.push(root);
  const stack = [root];
  const args = (name, options, fn) => {
    if (state.closed) throw new Error('LATE_REGISTRATION: the collected test set is already frozen');
    if (typeof options === 'function') { fn = options; options = {}; }
    if (typeof name !== 'string' || !name || !options || typeof options !== 'object' || typeof fn !== 'function') {
      throw new Error('Expected test/describe(name, [options], callback)');
    }
    if (options.only) throw new Error('Focused .only declarations are forbidden');
    for (const key of Object.keys(options)) if (!['tags', 'id', 'timeout', 'concurrency', 'skip', 'todo', 'only'].includes(key)) {
      throw new Error(`Unsupported declaration option: ${key}`);
    }
    return { name, options, fn };
  };
  function test(name, options, fn) {
    ({ name, options, fn } = args(name, options, fn));
    const parent = stack.at(-1);
    const finalTags = normalizeTags(inheritTags(parent.tags, options.tags));
    const names = [...stack.slice(1).map(s => s.name), name];
    const id = options.id ?? `${path}::${names.map(encodeURIComponent).join('/')}`;
    if (typeof id !== 'string' || !id || /[\r\n\0]/.test(id)) throw new Error('Invalid testcase ID');
    if (state.ids.has(id)) throw new Error(`Duplicate test ID: ${id}`);
    state.ids.add(id);
    const invalid = [...stack.map(s => s.options), options].some(o => (o.skip !== undefined && o.skip !== false) || (o.todo !== undefined && o.todo !== false));
    parent.children.push({ kind: 'test', name, fn, options, descriptor: {
      id, source: path, sourceHash, runner: 'node', tags: finalTags,
      ...(invalid ? { forbiddenSkip: true } : {}),
    } });
  }
  function describe(name, options, fn) {
    ({ name, options, fn } = args(name, options, fn));
    const parent = stack.at(-1);
    const node = { kind: 'suite', name, children: [], hooks: [], options,
      tags: inheritTags(parent.tags, options.tags) };
    parent.children.push(node);
    stack.push(node);
    try {
      const returned = fn();
      if (returned && typeof returned.then === 'function') throw new Error('Suite registration must be synchronous');
    } finally { stack.pop(); }
  }
  for (const [name, fn] of [['test', test], ['describe', describe]]) {
    fn.skip = (title, options, body) => typeof options === 'function'
      ? fn(title, { skip: true }, options) : fn(title, { ...options, skip: true }, body);
    fn.todo = (title, options, body) => typeof options === 'function'
      ? fn(title, { todo: true }, options) : fn(title, { ...options, todo: true }, body);
    fn.only = () => { throw new Error(`${name}.only is forbidden`); };
  }
  const hooks = Object.fromEntries(['before', 'after', 'beforeEach', 'afterEach'].map(name => [name, (fn, options = {}) => {
    if (state.closed) throw new Error('LATE_REGISTRATION: hooks are already frozen');
    if (typeof fn !== 'function') throw new TypeError('Hook must be a function');
    stack.at(-1).hooks.push({ name, fn, options });
  }]));
  Object.assign(test, hooks);
  return { test, it: test, describe, ...hooks };
}
