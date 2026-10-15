// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Execute without blocking the scheduler; retain diagnostics on every exit. */
export function invokeWorker(command, args, { root, env, outputDir, name, timeoutMs = 120_000, signal }) {
  return new Promise((resolve, reject) => {
    const isolatedEnv = { ...env };
    delete isolatedEnv.NODE_TEST_CONTEXT;
    const startedAt = new Date();
    let stdout = '', stderr = '', bytes = 0, error, stopTimer, timeout;
    const detached = process.platform !== 'win32';
    const child = spawn(command, args, { cwd: root, env: isolatedEnv, detached, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = kind => {
      if (detached && child.pid) {
        try { process.kill(-child.pid, kind); } catch (failure) { if (failure.code !== 'ESRCH') child.kill(kind); }
      } else child.kill(kind);
    };
    const stop = reason => {
      if (error) return;
      error = reason;
      kill('SIGTERM');
      stopTimer = setTimeout(() => kill('SIGKILL'), 1_000);
    };
    const abort = () => stop(new Error('WORKER_ABORTED'));
    const capture = (key, chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 16 * 1024 * 1024) { stop(new Error('WORKER_OUTPUT_LIMIT')); return; }
      if (key === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', chunk => capture('stdout', chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => capture('stderr', chunk));
    child.on('error', failure => { error ??= failure; });
    child.on('close', (status, childSignal) => {
      clearTimeout(timeout); clearTimeout(stopTimer);
      signal?.removeEventListener('abort', abort);
      // A terminated wrapper may leave a grandchild that closed its stdio.
      if (error) kill('SIGKILL');
      const durationMs = Date.now() - startedAt.getTime();
      try {
        writeFileSync(join(outputDir, `${name}.log`), `${stdout}\n${stderr}${error ? `\n${error.message}\n` : ''}`);
        writeFileSync(join(outputDir, `${name}-timing.json`), JSON.stringify({ startedAt, durationMs, status, signal: childSignal, error: error?.message ?? null }) + '\n');
        resolve({ status: error ? null : status, signal: childSignal, error, stdout, stderr });
      } catch (failure) { reject(failure); }
    });
    timeout = setTimeout(() => stop(new Error(`WORKER_TIMEOUT: ${timeoutMs}ms`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
