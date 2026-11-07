// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

// Numeric execution measurements of one real E2E case, read through the same
// public HTTP API the Web client uses. Only identities and non-negative
// integers leave this module: prompts, answers, traces and errors stay in the
// API responses. A value that cannot be established exactly is omitted, so the
// case table shows n/a instead of a partial sum or an invented 0.

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** The exact sum of counts; an empty list or any missing/invalid entry has none. */
export function exactSum(values) {
  if (!Array.isArray(values) || !values.length || values.some(value => count(value) === undefined)) return undefined;
  return count(values.reduce((sum, value) => sum + value, 0));
}

/**
 * Generator tokens from a GET /api/sessions/:id/usage summary. Its bucket totals
 * add only reported calls, so one unreported call would silently shrink them;
 * read the invocation ledger instead and give up on the first call that is not
 * reported with all three token counts.
 */
export function sessionUsageTokens(summary) {
  const calls = summary?.invocations;
  if (!Array.isArray(calls)) return {};
  const listed = summary.totals?.invocationCount;
  if (listed !== undefined && listed !== calls.length) return {};
  if (!calls.every(call => call?.usageStatus === 'reported'
    && [call.inputTokens, call.outputTokens, call.totalTokens].every(value => count(value) !== undefined))) return {};
  const generated = exactSum(calls.map(call => call.outputTokens)), total = exactSum(calls.map(call => call.totalTokens));
  return generated === undefined || total === undefined ? {} : { generation_output_tokens: generated, total_tokens: total };
}

/** The tool call identity an event carries, `null` for an unidentifiable tool event, `undefined` for any other event. */
function toolCallId(event) {
  const trace = event?.type === 'tool.started' || event?.type === 'tool.completed';
  const step = event?.type === 'subagent.step' && event.step?.kind === 'tool';
  if (!trace && !step) return undefined;
  const id = trace ? event.trace?.id : event.step.toolCallId;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Distinct tool calls across event record lists (main run streams, subagent
 * streams, evolve run events). A list that could not be read is `undefined`.
 * An unread list, a truncated history or a tool event without an identity
 * leaves the count unknown; lists that were read and hold no tool call give 0.
 */
export function toolCallCount(streams) {
  const ids = new Set();
  for (const records of streams) {
    if (!Array.isArray(records)) return undefined;
    for (const record of records) {
      if (record?.event?.type === 'run.history.truncated') return undefined;
      const id = toolCallId(record?.event);
      if (id === null) return undefined;
      if (id !== undefined) ids.add(id);
    }
  }
  return ids.size;
}

async function sessionToolCalls(read, session, evolveRunIds) {
  const [runs, children] = [await read(`${session}/runs`), await read(`${session}/subagents`)];
  // No run means no event stream was ever read: unknown, not zero.
  if (!Array.isArray(runs) || !runs.length || !Array.isArray(children)) return undefined;
  if (![...runs, ...children].every(item => typeof item?.id === 'string' && item.id)) return undefined;
  const streams = [];
  const add = records => { streams.push(records); return Array.isArray(records); };
  for (const run of runs) {
    const prefix = `${session}/runs/${encodeURIComponent(run.id)}`;
    if (!add(await read(`${prefix}/events`))) return undefined;
    for (const child of children) {
      if (!add(await read(`${prefix}/streams/${encodeURIComponent(`subagent-${child.id}`)}/events`))) return undefined;
    }
  }
  for (const id of evolveRunIds) if (!add(await read(`/api/evolve/runs/${encodeURIComponent(id)}/events`))) return undefined;
  // The subagent catalog keeps a projection of each child's steps. A tool step
  // there that no stream recorded means the streams are incomplete.
  const recorded = new Set(streams.flat().map(record => toolCallId(record?.event)).filter(Boolean));
  for (const child of children) {
    if (!Array.isArray(child.steps)) return undefined;
    if (child.steps.some(step => step?.kind === 'tool' && !recorded.has(step.toolCallId))) return undefined;
  }
  return toolCallCount(streams);
}

/**
 * Shared measurements of one Session. `get(path)` resolves the parsed JSON of an
 * authenticated API GET and rejects on any failure. Never throws: a failed read
 * only omits the fields it would have supplied.
 */
export async function collectCaseMeasurements(get, sessionId, { evolveRunIds = [] } = {}) {
  const read = path => Promise.resolve().then(() => get(path)).catch(() => undefined);
  const session = `/api/sessions/${encodeURIComponent(sessionId)}`;
  const measurements = { ...sessionUsageTokens(await read(`${session}/usage`)) };
  const tools = await sessionToolCalls(read, session, evolveRunIds).catch(() => undefined);
  if (tools !== undefined) measurements.tool_calls = tools;
  return measurements;
}

/**
 * The frozen-plan identity of a running Playwright case, built like the tagged
 * reporter builds it: `playwright:<source>::<project>/<file>/<describe…>/<title>`.
 * A unique plan entry also supplies the tagged key.
 */
export function caseIdentity({ source, project, titlePath }, entries = []) {
  const id = `playwright:${source}::${[project, ...titlePath].filter(Boolean).map(encodeURIComponent).join('/')}`;
  const title = encodeURIComponent(titlePath.at(-1) ?? '');
  const exact = entries.filter(entry => entry?.id === id);
  const candidates = exact.length ? exact : entries.filter(entry => entry?.source === source && entry.id?.endsWith(`/${title}`));
  const [entry] = candidates;
  if (candidates.length !== 1 || typeof entry.id !== 'string') return { case: id };
  return typeof entry.key === 'string' ? { case: entry.id, key: entry.key } : { case: entry.id };
}
