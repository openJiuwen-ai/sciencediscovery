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
import { createTest as taggedTest } from './node.mjs';
import { hostPlatform, hostArch } from './environment.mjs';

const declares = (tags, group, value) => {
  const declared = tags.filter(tag => tag.startsWith(`${group}:`));
  return !declared.length || declared.includes(`${group}:${value}`);
};

/**
 * A package's own `node --test` command has no plan and no target, so a file
 * that declares another platform has nothing it can run there. Registering
 * nothing is what those files did before they were tagged, when each test
 * skipped itself on the wrong host.
 */
function inapplicable() {
  const declaration = () => {};
  declaration.skip = declaration; declaration.todo = declaration; declaration.only = declaration;
  const hooks = Object.fromEntries(['before', 'after', 'beforeEach', 'afterEach'].map(name => [name, () => {}]));
  Object.assign(declaration, hooks);
  return { ...native, test: declaration, it: declaration, describe: declaration, ...hooks };
}

/**
 * Keep package-level `node --test` commands working while a shared run freezes
 * declarations. The platform check below belongs to this convenience path only:
 * the shared plan selects from the tags alone and never consults the host, so
 * a macOS case is absent from a Linux plan and present in a macOS one either
 * way.
 */
export function createTest(file, options) {
  if (globalThis[Symbol.for('sciencediscovery.tagged.registry')]) return taggedTest(file, options);
  const tags = options?.tags ?? [];
  if (!declares(tags, 'os', hostPlatform(process.platform)) || !declares(tags, 'arch', hostArch(process.arch))) {
    return inapplicable();
  }
  return native;
}
