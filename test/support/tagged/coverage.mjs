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
 * Coverage measures the same tests CI runs, chosen the same way.
 *
 * A coverage group is a directory of product source. What runs for that group
 * is not "the test files under it" — it is the entries of the shared plan whose
 * source lives under it. The plan is built here from `profiles`, so the
 * selector and the target matrix are the ones `pnpm test:shared` uses and
 * cannot be restated: a case the merge gate leaves out (`status:external`,
 * `model:real`, `npu:required`, another OS) is absent from a coverage run for
 * the same reason it is absent from `pnpm ci:ut`, and no probe of the machine
 * can add it back or take it away.
 *
 * Incremental coverage still decides *which* groups to measure. That narrows
 * the directories, never the rule that picks the tests inside one.
 */

import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { join } from 'node:path';

import { createPlan } from './plan.mjs';
import { profiles, nodeSources, pythonProjects, pythonSources } from './profiles.mjs';

/**
 * Editing any of these changes which identities a group contains, so an
 * incremental run over a few directories can no longer be trusted to represent
 * the change. Both coverage scope selectors fall back to a full run when one of
 * them is touched.
 */
export const planSources = Object.freeze([
  'test/support/tagged/coordinator.mjs',
  'test/support/tagged/coverage.mjs',
  'test/support/tagged/plan.mjs',
  'test/support/tagged/profiles.mjs',
  'test/support/tagged/schema.json',
  'test/support/tagged/tags.mjs',
]);

/** The directory a coverage report is attributed to, or nothing if it has none. */
export function groupOf(source) {
  const parts = source.split('/');
  if (['.ci', 'config', 'scripts'].includes(parts[0])) return parts[0];
  if (['apps', 'packages', 'services'].includes(parts[0]) && parts[1]) return `${parts[0]}/${parts[1]}`;
  return undefined;
}

/**
 * Where a group's tests run. This follows the shared runner: a workspace
 * package runs from its own directory, everything else from the repository
 * root, so a test reading a relative path finds what it found under
 * `pnpm test:shared`.
 */
export const groupCwd = (root, name) => (name.includes('/') ? join(root, name) : root);

export const headRevision = root => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();

const grouped = files => {
  const groups = new Map();
  for (const file of files) {
    const name = groupOf(file);
    if (!name) continue;
    groups.set(name, [...(groups.get(name) ?? []), file]);
  }
  return [...groups].map(([name, sources]) => ({ name, files: sources.sort() }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
};

/**
 * The Node groups, discovered from the same source patterns the shared runner
 * collects from. A package whose tests those patterns do not reach has no
 * coverage group, which is the same failure `pnpm ci:catalog:check` reports —
 * one definition of where tests live, not two.
 */
export const nodeGroups = root => grouped(globSync([...nodeSources], { cwd: root }).map(f => f.replaceAll('\\', '/')));

/** The Python groups: one per service project, named like its directory. */
export const pythonGroups = root => grouped(pythonProjects
  .flatMap(project => globSync(pythonSources(project), { cwd: root }).map(f => f.replaceAll('\\', '/'))));

/**
 * Freeze the plan for a catalog under a named CI profile. The selector and the
 * targets come from the profile object, never from a copy of its text.
 */
export function planFor(catalog, { root, profileName = 'pr', revision = headRevision(root) } = {}) {
  const profile = profiles[profileName];
  if (!profile) throw new Error(`Unknown profile: ${profileName}; known are ${Object.keys(profiles).join(', ')}`);
  return createPlan(catalog, { revision, selector: profile.selector, targets: profile.targets });
}

/** Split a frozen plan into the groups its entries belong to. */
export function entriesByGroup(plan) {
  const groups = new Map();
  for (const entry of plan.entries) {
    const name = groupOf(entry.source);
    if (!name) continue;
    groups.set(name, [...(groups.get(name) ?? []), entry]);
  }
  return groups;
}
