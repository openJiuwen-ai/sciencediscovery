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
import { readFileSync, writeFileSync, readdirSync, realpathSync, statSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, relative, join, isAbsolute, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlan, verifyResults, digest, canonical, subplan } from './plan.mjs';
import { preflight, hostPlatform, hostArch } from './environment.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const ignored = new Set(['.git', 'node_modules', '.venv', 'venv', '.e2e', 'dist', '.test-runs', '__pycache__', '.pytest_cache']);
export function inside(root, path) {
  const absolute = realpathSync(resolve(root, path));
  const rel = relative(realpathSync(root), absolute);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error(`Path escapes repository: ${path}`);
  return absolute;
}

/** Every candidate in an explicitly requested source scope must be understood. */
export function discoverFiles(root, paths) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('An explicit --path scope is required during migration');
  const found = new Set();
  function walk(path, explicit = false) {
    const absolute = inside(root, path);
    const info = statSync(absolute);
    if (info.isDirectory()) {
      for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a,b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (ignored.has(entry.name)) continue;
        if (entry.isSymbolicLink()) throw new Error(`Symlink in test scope: ${join(path, entry.name)}`);
        walk(join(path, entry.name));
      }
    } else if (explicit || /(?:\.test\.(?:mjs|cjs|js|ts|tsx)|\.spec\.(?:js|ts|tsx)|(?:^|[\\/])test_[^/\\]+\.py|_test\.py)$/.test(path)) {
      found.add(relative(root, absolute).replaceAll('\\', '/'));
    }
  }
  paths.forEach(path => walk(path, true));
  if (!found.size) throw new Error('EMPTY_SELECTION: no test source files in the requested scope');
  for (const file of found) {
    if (/\.spec\./.test(file)) throw new Error(`Playwright source requires a migrated adapter; it cannot be silently ignored: ${file}`);
    if (!/\.(?:mjs|js|ts|py)$/.test(file)) throw new Error(`Unsupported test source: ${file}`);
  }
  return [...found].sort();
}
const writeJSON = (path, data) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
function invoke(command, args, { root, env, outputDir, name, timeoutMs = 120_000 }) {
  const isolatedEnv = { ...env };
  // Nested node:test processes must not inherit the parent's private worker flag.
  delete isolatedEnv.NODE_TEST_CONTEXT;
  const completed = spawnSync(command, args, { cwd: root, env: isolatedEnv, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(outputDir, `${name}.log`), `${completed.stdout ?? ''}\n${completed.stderr ?? ''}`);
  return completed;
}
// Plugin autoload stays off, so nothing installed in a project's environment
// can reorder, retry or skip a case. A plugin a suite genuinely needs is named
// by the project (`pythonPlugins` in profiles.mjs) and loaded by name, for
// collection and execution alike.
const plugins = names => names.flatMap(name => ['-p', name]);
const childEnv = env => ({ ...env, PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1', PYTEST_ADDOPTS: '', PYTEST_PLUGINS: '',
  PYTHONPATH: [join(here, 'python'), env.PYTHONPATH].filter(Boolean).join(delimiter) });
// pytest looks for its config before the science_tags plugin has declared its
// options, so a value passed as a separate argument is taken for a test path:
// `--science-root <repo>` made the repository root the place to search, and a
// project's own pytest settings (services/<name>/pyproject.toml) were never
// read. One token per option keeps the value out of that search.
const scienceOptions = options => Object.entries(options).map(([name, value]) => `--science-${name}=${value}`);

export function collect({ root, files, outputDir, python = 'python3', pytestPlugins = [], nodeImports = [], env = process.env }) {
  mkdirSync(outputDir, { recursive: true });
  const catalog = [];
  const groups = { node: files.filter(f => !f.endsWith('.py')), python: files.filter(f => f.endsWith('.py')) };
  if (groups.node.length) {
    const input = join(outputDir, 'node-collect-request.json');
    const output = join(outputDir, 'node-catalog.json');
    rmSync(output, { force: true });
    writeJSON(input, { root, files: groups.node });
    const result = invoke(process.execPath, [...nodeImports.flatMap(p => ['--import', p]), join(here, 'node-collect.mjs'), input, output],
      { root, env, outputDir, name: 'node-collect' });
    if (result.status !== 0 || !existsSync(output)) throw new Error('NODE_COLLECTION_FAILED; inspect node-collect.log');
    catalog.push(...readJSON(output).catalog);
  }
  if (groups.python.length) {
    const output = join(outputDir, 'python-catalog.json');
    rmSync(output, { force: true });
    const result = invoke(python, ['-m', 'pytest', '-p', 'science_tags', ...plugins(pytestPlugins), '--strict-markers', '--rootdir', root, '--collect-only', '-q',
      ...scienceOptions({ root, catalog: output }), ...groups.python],
    { root, env: childEnv(env), outputDir, name: 'python-collect' });
    if (result.status !== 0 || !existsSync(output)) throw new Error('PYTHON_COLLECTION_FAILED; inspect python-collect.log');
    const pythonCatalog = readJSON(output).catalog;
    for (const file of groups.python) if (!pythonCatalog.some(c => c.source === file)) throw new Error(`EMPTY_MODULE: ${file}`);
    catalog.push(...pythonCatalog);
  }
  return catalog.sort((a,b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Read a run's reporter events back onto the identities that were planned.
 * Each planned test carries a token derived from its execution key, so a result
 * belongs to an identity rather than to a name that two files could share.
 * Anything that reports without a token ran outside the plan and is a problem,
 * not a result.
 */
export function nodeResults({ reportPath, entries, label }) {
  const results = [], errors = [];
  const tokens = new Map(entries.map(e => [digest(e.key), e]));
  if (existsSync(reportPath)) for (const line of readFileSync(reportPath, 'utf8').split('\n').filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { errors.push(`MALFORMED_EVENT: ${label}`); continue; }
    const token = event.name?.match(/\[science:([0-9a-f]{64})\]$/)?.[1];
    if (token) {
      const entry = tokens.get(token);
      if (!entry) { errors.push(`UNEXPECTED_NODE_TEST: ${token}`); continue; }
      results.push({ key: entry.key, outcome: event.skip ? 'SKIPPED' : event.todo ? 'TODO' : event.type === 'test:pass' ? 'PASS' : 'FAIL',
        actualTarget: { os: hostPlatform(process.platform), arch: hostArch(process.arch) } });
    } else if (event.type === 'test:fail') errors.push(`NODE_HOOK_OR_COLLECTION_FAILED: ${event.name}`);
    else if (event.type === 'test:pass' && event.kind !== 'suite') errors.push(`UNPLANNED_NODE_TEST: ${event.name}`);
  }
  return { results, errors };
}

/**
 * Node writes lcov paths relative to the worker's directory and names no test.
 * Rewrite both, so every record says by itself which test file produced it and
 * which repository file it measures — the data then means the same thing
 * wherever it is read, including after it has been handed to another job.
 */
export function relocateLcov(text, { root, cwd, source }) {
  return text.split('\n').flatMap(line => {
    if (line.startsWith('TN:')) return [];
    if (!line.startsWith('SF:')) return [line];
    const absolute = resolve(cwd, line.slice(3));
    const inRepository = relative(root, absolute);
    const file = inRepository.startsWith('..') || isAbsolute(inRepository) ? absolute : inRepository.replaceAll('\\', '/');
    return [`TN:${source}`, `SF:${file}`];
  }).join('\n');
}

export async function execute({ root, cwd = root, plan, outputDir, python = 'python3', pytestPlugins = [], nodeImports = [], coverageDir, env = process.env, timeoutMs = 300_000 }) {
  validatePlan(plan);
  for (const entry of plan.entries) inside(root, entry.source);
  mkdirSync(outputDir, { recursive: true });
  writeJSON(join(outputDir, 'plan.json'), plan); // Written BEFORE inspecting environment.
  const checked = await preflight(plan, { env });
  writeJSON(join(outputDir, 'preflight.json'), checked);
  const errors = checked.problems.map(p => `${p.code}: ${p.key}`);
  const results = [];
  if (checked.ok) {
    const groups = new Map();
    for (const entry of plan.entries) {
      const key = `${entry.runner}:${entry.runner === "node" ? entry.source : "python"}:${canonical(entry.target)}`;
      const entries = groups.get(key) ?? [];
      entries.push(entry); groups.set(key, entries);
    }
    let index = 0;
    for (const entries of groups.values()) {
      const name = `worker-${++index}`;
      const files = [...new Set(entries.map(e => e.source))];
      const part = subplan(plan, entries);
      const request = join(outputDir, `${name}.json`);
      const resultPath = join(outputDir, `${name}-results.json`);
      rmSync(resultPath, { force: true });
      if (entries[0].runner === 'node') {
        writeJSON(request, { root, files, plan: part, timeoutMs });
        const nativeReport = join(outputDir, `${name}-events.jsonl`);
        rmSync(nativeReport, { force: true });
        // A Node worker holds exactly one source (the grouping key above), so
        // the coverage it records is that one test file's, named after it —
        // never with a leading dot: `.ci/…` would make a hidden file, which
        // artifact uploads leave out without a word.
        const lcov = coverageDir && join(coverageDir, `${files[0].replaceAll('/', '__').replace(/^\./, '_')}.lcov`);
        if (lcov) { mkdirSync(coverageDir, { recursive: true }); rmSync(lcov, { force: true }); }
        const completed = invoke(process.execPath, [...nodeImports.flatMap(p => ['--import', p]),
          // Source maps let records from built output a test reaches — another
          // package's dist/, a child started from dist/server.js — resolve to
          // the TypeScript they were compiled from.
          ...(lcov ? ['--enable-source-maps', '--experimental-test-coverage'] : []), '--test',
          '--test-reporter', join(here, 'node-reporter.mjs'), '--test-reporter-destination', nativeReport,
          ...(lcov ? ['--test-reporter', 'lcov', '--test-reporter-destination', lcov] : []),
          join(here, 'node-worker.mjs')],
        { root: cwd, env: { ...env, SCIENCE_TAG_RUN_REQUEST: request }, outputDir, name, timeoutMs });
        if (completed.status !== 0) errors.push(`NODE_WORKER_FAILED: ${name}`);
        if (lcov && existsSync(lcov)) writeFileSync(lcov, relocateLcov(readFileSync(lcov, 'utf8'), { root, cwd, source: files[0] }));
        const reported = nodeResults({ reportPath: nativeReport, entries, label: name });
        results.push(...reported.results); errors.push(...reported.errors);
      } else {
        writeJSON(request, part);
        const completed = invoke(python, ['-m', 'pytest', '-p', 'science_tags', ...plugins(pytestPlugins), '--strict-markers', '--rootdir', root, '-q',
          ...scienceOptions({ root, plan: request, report: resultPath }), ...files.map(f => resolve(root, f))],
        { root: cwd, env: childEnv(env), outputDir, name, timeoutMs });
        if (completed.status !== 0) errors.push(`PYTHON_WORKER_FAILED: ${name}`);
        if (existsSync(resultPath)) results.push(...readJSON(resultPath).results);
      }
    }
  }
  const summary = verifyResults(plan, results, errors);
  writeJSON(join(outputDir, 'summary.json'), summary);
  return summary;
}
