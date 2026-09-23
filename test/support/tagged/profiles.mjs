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

/**
 * CI policy, written as the question a reader actually asks: which dimensions
 * does this profile take? One row is one rule; a group with several values is
 * OR inside the row, different groups are AND, and several rows are OR between
 * them. The selector string every command runs is derived from these rows, so
 * this is the only place a policy is stated.
 *
 * `pr` is one rule today because the three categories differ in nothing but
 * their name. The shape is a list because `daily` will grow rows that `pr` does
 * not have — a live-model journey, a `judge:llm` case — as soon as there are
 * cases to put in them.
 */
const PR = [
  { category: ['ut', 'st', 'e2e'], os: 'linux', arch: 'amd64', npu: 'none', model: ['none', 'mock'], judge: 'none', status: 'reviewed' },
];

/**
 * Daily is PR plus real browser journeys. Credentials are checked only after
 * this policy has frozen identities; a missing secret never removes a case.
 */
const DAILY = [...PR,
  { category: 'e2e', os: 'linux', arch: 'amd64', npu: 'none', model: 'real', judge: ['none', 'llm'], status: ['reviewed', 'external'] },
];

const policies = {
  pr: PR,
  daily: DAILY,
  // Paid research belongs to daily CI only. Releases keep all hermetic gates.
  release: PR,
};

/** One rule: a group with several values is OR, different groups are AND. */
export function ruleSelector(rule) {
  return Object.entries(rule)
    .map(([group, value]) => Array.isArray(value) && value.length > 1
      ? `(${value.map(v => `${group}:${v}`).join(' or ')})`
      : `${group}:${[value].flat()[0]}`)
    .join(' and ');
}

/** Several rules: OR between them, each parenthesised so precedence cannot bite. */
export function policySelector(rules) {
  return rules.length === 1 ? ruleSelector(rules[0]) : rules.map(r => `(${ruleSelector(r)})`).join(' or ');
}

const entries = Object.entries(policies);
export const profiles = Object.freeze(Object.fromEntries(entries.map(([name, rules]) => [name, Object.freeze({
  name,
  // Two profiles sharing one rule list are the same policy by construction, not
  // by somebody keeping two copies in step. `test:policy` says which.
  definedAs: entries.find(([, other]) => other === rules)[0],
  rules: Object.freeze(rules.map(Object.freeze)),
  selector: policySelector(rules),
  // Every rule in a profile names the same execution target today; a profile
  // that ever spans two would list both here.
  targets: [...new Map(rules.map(r => [`${r.os}/${r.arch}`, { os: [r.os].flat()[0], arch: [r.arch].flat()[0] }])).values()],
})])));

/** What a command runs when no profile is named. */
export const shared = profiles.pr;

/**
 * The slices CI schedules as separate jobs. `category` is single-valued and
 * required, so `ut`, `st` and `e2e` partition the shared plan: their union is
 * `pnpm test:shared` exactly, with nothing selected twice and nothing dropped.
 */
export const slices = Object.freeze({
  shared: '',
  ut: 'category:ut',
  st: 'category:st',
  e2e: 'category:e2e and not model:real',
  'e2e-real': 'category:e2e and model:real',
});

/**
 * Where the shared runner looks for declarations. This follows the workspace
 * layout and nothing else — never an installed capability, never an
 * environment gate. `pnpm ci:catalog:check` measures it against the workspace,
 * so a package whose tests live somewhere these patterns do not reach is a
 * failure rather than coverage that silently stops being collected.
 */
export const nodeSources = Object.freeze([
  '.ci/*.test.mjs',
  'apps/web/tests/**/*.test.*',
  'config/test/*.test.mjs',
  'packages/*/src/**/*.test.ts',
  'scripts/*.test.mjs',
  'scripts/binary-release/*.test.mjs',
  'services/*/src/**/*.test.ts',
  'services/runner/scripts/*.test.mjs',
  'test/contract/*.test.mjs',
  'test/helpers/*.unit.ts',
  'test/fixtures/*.test.mjs',
  'test/benchmarks/**/*.test.ts',
  'test/benchmarks/**/*.unit.ts',
]);

/** Declarations that are not named like one, and so cannot be found by a pattern. */
export const nodeExtraSources = Object.freeze(['test/api/agent_loop_smoke.ts']);

/** The Python service suites, each collected against its own project virtualenv. */
export const pythonProjects = Object.freeze(['paper', 'gateway', 'memory-graph', 'evolve', 'adapter']);
export const pythonSources = project => `services/${project}/tests/test_*.py`;

/**
 * Third-party pytest plugins a project's suite needs. The runner disables
 * plugin autoload — an installed plugin must not be able to retry, reorder or
 * skip a case — so each one a suite relies on is named here and loaded
 * explicitly. The adapter writes its tests as `async def` for pytest-asyncio.
 */
export const pythonPlugins = Object.freeze({ adapter: Object.freeze(['pytest_asyncio.plugin']) });
