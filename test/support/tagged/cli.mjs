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

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { schema } from './tags.mjs';
import { createPlan, validatePlan } from './plan.mjs';
import { preflight } from './environment.mjs';
import { profiles } from './profiles.mjs';
import { discoverFiles, collect, execute } from './coordinator.mjs';

const defaultRoot = fileURLToPath(new URL('../../../', import.meta.url));
export function parse(args) {
  const [action = 'list', ...rest] = args;
  if (!['list', 'run', 'doctor', 'tags'].includes(action)) throw new Error(`Unknown action: ${action}`);
  const options = { action, paths: [], nodeImports: [] };
  const fields = { '--root': 'root', '--path': 'paths', '--select': 'selector', '--os': 'os', '--arch': 'arch',
    '--profile': 'profile', '--plan': 'plan', '--output': 'output', '--python': 'python',
    '--revision': 'revision', '--import': 'nodeImports' };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--') continue;
    const key = fields[rest[i]];
    if (!key) throw new Error(`Unknown argument: ${rest[i]}`);
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing argument value: ${rest[i-1]}`);
    if (Array.isArray(options[key])) options[key].push(value);
    else {
      if (seen.has(key)) throw new Error(`Duplicate option: ${key}`);
      seen.add(key); options[key] = value;
    }
  }
  if (options.plan && (options.paths.length || options.selector || options.profile || options.os || options.arch)) {
    throw new Error('--plan cannot be combined with a new selection or target');
  }
  if (options.profile && (options.selector || options.os || options.arch)) {
    throw new Error('A fixed profile cannot be overridden; use an explicit selector/target instead');
  }
  return options;
}
export async function main(args = process.argv.slice(2)) {
  const options = parse(args);
  if (options.action === 'tags') { console.log(JSON.stringify(schema, null, 2)); return 0; }
  const root = resolve(options.root ?? defaultRoot);
  const outputDir = resolve(options.output ?? join(root, '.test-runs', `tagged-${Date.now()}-${process.pid}`));
  mkdirSync(outputDir, { recursive: true });
  let plan;
  if (options.plan) {
    plan = validatePlan(JSON.parse(readFileSync(resolve(options.plan), 'utf8')));
  } else {
    const profile = options.profile ? profiles[options.profile] : null;
    if (options.profile && !profile) throw new Error(`Unknown profile: ${options.profile}`);
    if (!profile && !(options.os && options.arch)) throw new Error('Specify --os and --arch; target selection never uses the host environment');
    const files = discoverFiles(root, options.paths);
    const catalog = collect({ root, files, outputDir, python: options.python, nodeImports: options.nodeImports });
    const revision = options.revision ?? spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
    plan = createPlan(catalog, { revision, selector: profile?.selector ?? options.selector,
      targets: profile?.targets ?? [{ os: options.os, arch: options.arch }], ...(profile ? { profile: options.profile } : {}) });
  }
  writeFileSync(join(outputDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  if (options.action === 'list') { console.log(JSON.stringify(plan, null, 2)); return 0; }
  if (options.action === 'doctor') {
    const result = await preflight(plan);
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  const summary = await execute({ root, plan, outputDir, python: options.python, nodeImports: options.nodeImports });
  console.log(JSON.stringify({ status: summary.status, planned: summary.planned, passed: summary.passed, skipped: summary.skipped, outputDir }, null, 2));
  return summary.exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
