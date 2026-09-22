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

// The only shared policy. Every local and CI command below runs this one
// selector against this one target; a slice narrows it with a category/tier
// predicate and never with a second hand-written list of cases.
export const shared = Object.freeze({
  selector: '(category:ut or category:st or category:e2e) and os:linux and arch:amd64 and npu:none and (model:none or model:mock) and judge:none and status:reviewed',
  targets: [{ os: 'linux', arch: 'amd64', executor: 'independent' }],
});

/**
 * The slices CI schedules as separate jobs. `category` is single-valued and
 * required, so `ut`, `st` and `e2e` partition the shared plan: their union is
 * `pnpm test:shared` exactly, with nothing selected twice and nothing dropped.
 * `tier` does the same inside `ut`, which is why the aggregate `ut` slice is
 * `ut-host` followed by `ut-guest` and why a UT case without a tier fails the
 * run rather than disappearing from it.
 */
export const slices = Object.freeze({
  shared: '',
  ut: 'category:ut',
  st: 'category:st',
  e2e: 'category:e2e',
  'ut-host': 'category:ut and tier:host',
  'ut-guest': 'category:ut and tier:guest',
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
]);

/** Declarations that are not named like one, and so cannot be found by a pattern. */
export const nodeExtraSources = Object.freeze(['test/api/agent_loop_smoke.ts']);

/** The Python service suites, each collected against its own project virtualenv. */
export const pythonProjects = Object.freeze(['paper', 'gateway', 'memory-graph', 'evolve']);
export const pythonSources = project => `services/${project}/tests/test_*.py`;

export const profiles = Object.freeze({ shared, pr: shared });
