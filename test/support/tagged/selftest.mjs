#!/usr/bin/env node
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

import { readdirSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = fileURLToPath(new URL('.', import.meta.url));
const files = [];
function visit(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) visit(child);
    else if (entry.name.endsWith('.test.mjs')) files.push(child);
  }
}
visit(join(here, 'tests'));
if (!files.length) throw new Error('No harness regression tests found');
let failed = false;
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
for (const [command, args, runEnv] of [
  [process.execPath, ['--test', ...files.sort()], env],
  [env.SCIENCE_TEST_PYTHON ?? 'python3', [join(here, 'python/check_llm_helper.py')],
    { ...env, PYTHONPATH: [join(here, 'python'), env.PYTHONPATH].filter(Boolean).join(delimiter) }],
]) {
  const result = spawnSync(command, args, { env: runEnv, stdio: 'inherit', timeout: 180_000 });
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
