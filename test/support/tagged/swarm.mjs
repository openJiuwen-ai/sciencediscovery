#!/usr/bin/env node
// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * What points a process at a JiuwenSwarm instance and its adapter. A worker
 * whose tests do not declare `swarm:required` gets none of these, whatever the
 * shell that started the run exported, so even a test that boots
 * `createApiServer` stays on the built-in loop and never reaches the instance.
 */
export const swarmVariables = Object.freeze([
  'SCIENCE_AGENT_EXECUTOR', 'SCIENCE_AGENT_ADAPTER_URL', 'SCIENCE_AGENT_ADAPTER_TOKEN',
  'SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS', 'JIUWENSWARM_GATEWAY_URL', 'JIUWENSWARM_MGMT_URL',
]);

export function withoutSwarm(env) {
  const copy = { ...env };
  for (const name of swarmVariables) delete copy[name];
  return copy;
}

/** What the wrapper hands a declaring worker: the variables above plus which instance they name. */
const handed = [...swarmVariables, 'JIUWENSWARM_INSTANCE', 'JIUWENSWARM_HOME'];

const self = fileURLToPath(import.meta.url);

/**
 * Start the run's one JiuwenSwarm instance and its one adapter, through the
 * same `scripts/with-jiuwenswarm.sh` a person uses by hand. The wrapper runs
 * this module's `hold` mode as its command: that reports the variables the
 * wrapper exported on stdout, then waits for its stdin to close. Closing it is
 * how `stop()` ends the hold, after which the wrapper stops what it started.
 *
 * `ready` resolves to those variables, which a declaring worker adds to its
 * environment, or rejects with the wrapper's own reason if it gave up first.
 * The instance has one tool server, so it serves one adapter, and the adapter
 * serves one test at a time: the caller's queue, not this function, keeps
 * declaring work from overlapping.
 */
export function startSwarm({ root, env, log }) {
  const output = createWriteStream(log, { flags: 'a' });
  const child = spawn('bash', [join(root, 'scripts/with-jiuwenswarm.sh'), process.execPath, self, 'hold'], {
    cwd: root, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.pipe(output, { end: false });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve(code ?? (signal ? 128 : 1))));
  child.once('error', error => output.write(`${error.stack}\n`));
  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try { resolve(JSON.parse(buffer.slice(0, end))); } catch (error) { reject(error); }
    });
    closed.then(code => reject(new Error(`SWARM_UNAVAILABLE: scripts/with-jiuwenswarm.sh exited ${code}; inspect ${log}`)));
  });
  // A failed start is reported by each declaring group; it is not an unhandled rejection here.
  ready.catch(() => {});
  let stopping;
  const stop = () => stopping ??= (async () => {
    child.stdin.end();
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    }, 60_000);
    const code = await closed;
    clearTimeout(timer);
    await new Promise(resolve => output.end(resolve));
    return code;
  })();
  return { ready, stop };
}

/** The wrapper's command: hand its exports back, then hold the instance until released. */
function hold() {
  const exported = Object.fromEntries(handed.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  process.stdout.write(`${JSON.stringify(exported)}\n`);
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === 'hold') hold();
