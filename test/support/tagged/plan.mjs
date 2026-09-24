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

import { createHash } from 'node:crypto';
import { normalizeTags, compileSelector, schema } from './tags.mjs';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const fileDigest = bytes => createHash('sha256').update(bytes).digest('hex');
export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function validateTarget(target) {
  if (!target || Object.keys(target).sort().join(',') !== 'arch,os') {
    throw new Error('Target must explicitly contain os and arch');
  }
  for (const key of ['os', 'arch']) {
    if (!schema.groups[key].values.includes(target[key])) throw new Error(`Invalid target ${key}:${target[key]}`);
  }
  return { os: target.os, arch: target.arch };
}
export function instanceKey(id, target) { return `${id}@${target.os}/${target.arch}`; }

/**
 * The same plan narrowed to a subset of its own entries: same revision, same
 * selector, same targets, a digest of its own. Everything that hands part of a
 * plan to a worker goes through here, so a subset can never be a plan somebody
 * rebuilt with different inputs.
 */
export function subplan(plan, entries) {
  const { digest: _replaced, ...data } = plan;
  const value = { ...data, entries };
  return freeze({ ...value, digest: digest(value) });
}

/** Pure: NEVER reads process.env, the host OS, credentials, devices or services. */
export function createPlan(catalog, { revision, selector = '', targets, profile } = {}) {
  if (typeof revision !== 'string' || !revision) throw new Error('A revision is required');
  if (!Array.isArray(targets) || !targets.length) throw new Error('An explicit target matrix is required');
  const matrix = targets.map(validateTarget);
  const match = compileSelector(selector);
  const byId = new Map();
  for (const raw of catalog) {
    if (!raw.id || !raw.source || !raw.sourceHash || !['node', 'python', 'playwright', 'command'].includes(raw.runner)) {
      throw new Error('Incomplete collected test identity');
    }
    if (byId.has(raw.id)) throw new Error(`Duplicate test ID: ${raw.id}`);
    byId.set(raw.id, { ...raw, tags: normalizeTags(raw.tags) });
  }
  const entries = new Map();
  for (const test of [...byId.values()].sort((a,b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    for (const requested of matrix) {
      if (!test.tags.includes(`os:${requested.os}`) || !test.tags.includes(`arch:${requested.arch}`)) continue;
      const target = { ...requested };
      // Match platform tags on concrete execution instances, not on a capability
      // union; e.g. `not os:linux` still selects a multi-OS test on macOS.
      const concrete = [...test.tags.filter(t => !/^(os|arch):/.test(t)),
        `os:${target.os}`, `arch:${target.arch}`];
      if (!match(concrete)) continue;
      const key = instanceKey(test.id, target);
      entries.set(key, { ...test, key, target, selectedTags: concrete.sort() });
    }
  }
  if (!entries.size) throw new Error('EMPTY_SELECTION: no test instances selected');
  if (profile !== undefined && (typeof profile !== 'string' || !/^[a-z][a-z0-9-]*$/.test(profile))) throw new Error('A profile is a policy name');
  // A plan frozen from a CI profile says so itself: every profile writes to
  // the same `<slice>/` directory, so the name cannot come from where it lies.
  const data = {
    version: 1, revision, selector, ...(profile === undefined ? {} : { profile }),
    targets: [...new Map(matrix.map(t => [canonical(t), t])).values()].sort((a,b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0)),
    catalogDigest: digest([...byId.values()].sort((a,b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))),
    entries: [...entries.values()].sort((a,b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  };
  return freeze({ ...data, digest: digest(data) });
}
export function validatePlan(plan) {
  if (!plan || plan.version !== 1 || !Array.isArray(plan.entries) || !plan.entries.length) throw new Error('Invalid or empty plan');
  const { digest: actual, ...data } = plan;
  if (digest(data) !== actual) throw new Error('PLAN_CHANGED: plan digest mismatch');
  const keys = new Set();
  for (const entry of plan.entries) {
    if (typeof entry.source !== 'string' || entry.source.startsWith('/') || entry.source.includes('\\')
      || entry.source.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(entry.sourceHash)
      || !['node', 'python', 'playwright', 'command'].includes(entry.runner)) throw new Error('Invalid source identity');
    normalizeTags(entry.tags);
    validateTarget(entry.target);
    if (entry.key !== instanceKey(entry.id, entry.target) || keys.has(entry.key)) throw new Error('Invalid/duplicate execution identity');
    keys.add(entry.key);
  }
  return plan;
}

/** Compare identities, not just counts. All skipped/xfail/todo/unstarted outcomes fail. */
export function verifyResults(plan, results, errors = []) {
  validatePlan(plan);
  const problems = [...errors];
  const expected = new Map(plan.entries.map(e => [e.key, e]));
  const seen = new Map();
  for (const r of results) {
    if (!expected.has(r.key)) { problems.push(`UNEXPECTED_RESULT: ${r.key}`); continue; }
    if (seen.has(r.key)) problems.push(`DUPLICATE_RESULT: ${r.key}`);
    seen.set(r.key, r);
    if (r.outcome !== 'PASS') problems.push(`${r.outcome || 'INVALID_OUTCOME'}: ${r.key}`);
    if (canonical(r.actualTarget) !== canonical(expected.get(r.key).target)) problems.push(`TARGET_MISMATCH: ${r.key}`);
  }
  for (const key of expected.keys()) if (!seen.has(key)) problems.push(`NOT_RUN: ${key}`);
  return {
    status: problems.length ? 'FAIL' : 'PASS', exitCode: problems.length ? 1 : 0,
    planDigest: plan.digest, planned: expected.size, reported: results.length,
    executed: [...seen.values()].filter(r => ["PASS", "FAIL"].includes(r.outcome)).length,
    failed: [...seen.values()].filter(r => r.outcome === "FAIL").length,
    passed: new Set(results.filter(r => r.outcome === 'PASS' && expected.has(r.key)
      && canonical(r.actualTarget) === canonical(expected.get(r.key).target)).map(r => r.key)).size,
    skipped: results.filter(r => ['SKIPPED', 'XFAIL', 'XPASS', 'TODO'].includes(r.outcome)).length,
    results, problems,
  };
}
