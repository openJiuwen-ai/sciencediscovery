// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile } from 'node:fs/promises';
import { cpus, totalmem, release } from 'node:os';

export const MEASUREMENT_VERSION = 'biomni-worker-v1';
const count = value => Number.isSafeInteger(value) && value >= 0;
export function generationTokens(usage, beforeIds = []) {
  if (!Array.isArray(usage?.invocations)) throw new Error('MISSING_TOKEN_LEDGER');
  const before = new Set(beforeIds), seen = new Set();
  const totals = { input: 0, output: 0, total: 0, invocations: 0 };
  for (const entry of usage.invocations.filter(e => !before.has(e.id))) {
    if (!entry.id || seen.has(entry.id)) throw new Error('DUPLICATE_TOKEN_INVOCATION');
    seen.add(entry.id);
    if (entry.usageStatus !== 'reported' || ![entry.inputTokens, entry.outputTokens, entry.totalTokens].every(count)) throw new Error('UNREPORTED_GENERATION_TOKENS');
    totals.input += entry.inputTokens; totals.output += entry.outputTokens; totals.total += entry.totalTokens; totals.invocations++;
  }
  if (!totals.invocations || !totals.total) throw new Error('EMPTY_GENERATION_TOKENS');
  return totals;
}

export function judgeTokens(attempts) {
  if (!Array.isArray(attempts) || !attempts.length) throw new Error('MISSING_JUDGE_ATTEMPTS');
  const totals = { input: 0, output: 0, total: 0, invocations: attempts.length,
    complete: true, unknown_attempts: 0, reported_attempts: 0 };
  for (const { usage } of attempts) {
    if (![usage?.prompt_tokens, usage?.completion_tokens, usage?.total_tokens].every(count)) {
      totals.complete = false; totals.unknown_attempts++; continue;
    }
    totals.reported_attempts++;
    totals.input += usage.prompt_tokens; totals.output += usage.completion_tokens; totals.total += usage.total_tokens;
  }
  return totals;
}

export function toolMetrics(records) {
  const calls = new Set(), rounds = new Set();
  for (const { event } of records) {
    if (event.type === 'run.history.truncated') throw new Error('TRUNCATED_TOOL_HISTORY');
    const id = event.type === 'tool.started' || event.type === 'tool.completed' ? event.trace?.id
      : event.type === 'subagent.step' && event.step?.kind === 'tool' ? event.step.toolCallId : undefined;
    if (!id && (['tool.started', 'tool.completed'].includes(event.type) || (event.type === 'subagent.step' && event.step?.kind === 'tool'))) throw new Error('MISSING_TOOL_CALL_IDENTITY');
    if (!id) continue;
    const e = event.evidence;
    if (!e?.agentId || !e.agentRunId || !count(e.turn)) throw new Error('MISSING_TOOL_ROUND_EVIDENCE');
    calls.add(JSON.stringify([e.agentId, e.agentRunId, id]));
    rounds.add(JSON.stringify([e.agentId, e.agentRunId, e.turn]));
  }
  if (!calls.size) throw new Error('EMPTY_TOOL_HISTORY');
  return { tool_calls: calls.size, tool_rounds: rounds.size };
}

// A completed initial turn can still leave shell executions, children or timers
// that wake the main agent. The caller also requires a stable final delivery.
export function settled(snapshot) {
  if (![snapshot.runs, snapshot.children, snapshot.activity?.executions, snapshot.activity?.transfers, snapshot.activity?.timers].every(Array.isArray)) throw new Error('INCOMPLETE_ACTIVITY_SNAPSHOT');
  const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'fired', 'partial']);
  return snapshot.runs.length > 0 && snapshot.runs.every(r => terminal.has(r.status))
    && snapshot.children.every(c => terminal.has(c.status))
    && [...snapshot.activity.executions, ...snapshot.activity.transfers, ...snapshot.activity.timers].every(x => terminal.has(x.state ?? x.status));
}

export function selectedProcesses(rows) {
  const selected = new Set(rows.filter(r => r.matches).map(r => r.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (selected.has(row.ppid) && !selected.has(row.pid)) { selected.add(row.pid); changed = true; }
  }
  return rows.filter(r => selected.has(r.pid));
}

// Local worker RSS (API, Runner, adapter, Swarm, browser, sandbox descendants).
// Shared pages can be counted more than once; this is not remote model memory
// or a kernel high-water mark. No process environment values are retained.
export async function startMemorySampler(dataRoot, intervalMs = 1000) {
  if (process.platform !== 'linux' || !dataRoot?.startsWith('/')) throw new Error('BLOCKED: Linux isolated-worker memory sampling required');
  const marker = Buffer.from(`SCIENCE_DISCOVERY_DATA_DIR=${dataRoot}\0`);
  let peak = 0, samples = 0, error;
  async function sample() {
    const rows = [];
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
        const rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
        const env = await readFile(`/proc/${pid}/environ`).catch(() => Buffer.alloc(0));
        rows.push({ pid: Number(pid), ppid, rss, matches: env.includes(marker) });
      } catch (e) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(e.code)) throw e; }
    }
    const own = selectedProcesses(rows);
    if (!own.length) throw new Error('NO_MEASURABLE_WORKER_PROCESSES');
    peak = Math.max(peak, own.reduce((sum, row) => sum + row.rss, 0)); samples++;
  }
  await sample();
  let pending = Promise.resolve();
  const timer = setInterval(() => { pending = pending.then(sample).catch(e => { error = e; }); }, intervalMs);
  return { async stop() {
    clearInterval(timer); await pending; await sample(); if (error) throw error;
    if (peak <= 0) throw new Error('MISSING_MEMORY_SAMPLES');
    return { peak_rss_bytes: peak, samples, interval_ms: intervalMs, scope: 'isolated-local-worker-rss-sum' };
  } };
}

export function machineIdentity() {
  return { os: process.platform, arch: process.arch, kernel: release(), cpu: cpus()[0]?.model, cores: cpus().length, memory_bytes: totalmem(), node: process.version };
}
