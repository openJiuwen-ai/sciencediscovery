// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
//
// Compare two OpenAI-compatible model endpoints with the same model alias,
// request body, workload and concurrency. It measures per-request wire latency
// only; agent duration and research scores come from the benchmark artifacts.
// Endpoint credentials are read from the environment and never written out.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CLASSIFICATIONS = ['aborted', 'empty_completion', 'invalid_response', 'network', 'parse', 'provider_http', 'reasoning_only', 'timeout', 'unknown'];

export function classifyFailure(error, status) {
  if (typeof status === 'number' && status >= 400) return 'provider_http';
  if (!error || typeof error !== 'object') return 'unknown';
  const code = 'cause' in error ? String(error.cause?.code ?? '') : '';
  if (/TIMEOUT|TIMEDOUT/i.test(code)) return 'timeout';
  if (error.name === 'AbortError') return 'aborted';
  if (code || error.name === 'TypeError') return 'network';
  return 'unknown';
}

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower));
}

function distribution(values) {
  return values.length ? { min: Math.min(...values), p50: percentile(values, 0.5),
    p90: percentile(values, 0.9), p95: percentile(values, 0.95), max: Math.max(...values) } : null;
}

/** One streaming request; returns bounded measurements only. */
async function requestOnce(endpoint, body, timeoutMs, active) {
  const startedAt = Date.now();
  const measured = { name: endpoint.name, status: undefined, error: undefined, elapsedMs: undefined,
    timeToHeadersMs: undefined, timeToFirstByteMs: undefined, timeToFirstRecordMs: undefined,
    bytes: 0, sseRecords: 0, sseParseErrors: 0, hasText: false, hasToolCalls: false,
    hasReasoning: false, finishReason: undefined, usage: undefined };
  active.count += 1;
  active.max = Math.max(active.max, active.count);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token || 'dummy'}` },
      body, signal: controller.signal,
    });
    measured.status = response.status;
    measured.timeToHeadersMs = Date.now() - startedAt;
    if (!response.ok) {
      measured.error = { classification: classifyFailure(undefined, response.status) };
      await response.body?.cancel();
      return { ...measured, elapsedMs: Date.now() - startedAt };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (measured.timeToFirstByteMs === undefined) measured.timeToFirstByteMs = Date.now() - startedAt;
      measured.bytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload && payload !== '[DONE]') {
            if (measured.timeToFirstRecordMs === undefined) measured.timeToFirstRecordMs = Date.now() - startedAt;
            measured.sseRecords += 1;
            try {
              const record = JSON.parse(payload);
              if (record?.error) throw new Error('provider error event');
              const choice = Array.isArray(record?.choices) ? record.choices[0] : undefined;
              if (typeof choice?.finish_reason === 'string') measured.finishReason = choice.finish_reason.slice(0, 40);
              const delta = choice?.delta ?? {};
              if (typeof delta.content === 'string' && delta.content.trim()) measured.hasText = true;
              if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) measured.hasToolCalls = true;
              if ((typeof delta.reasoning_content === 'string' && delta.reasoning_content.trim())
                || (typeof delta.reasoning === 'string' && delta.reasoning.trim())) measured.hasReasoning = true;
              if (record?.usage && typeof record.usage === 'object') {
                const total = record.usage.total_tokens;
                if (Number.isSafeInteger(total)) measured.usage = { totalTokens: total,
                  ...(Number.isSafeInteger(record.usage.prompt_tokens) ? { inputTokens: record.usage.prompt_tokens } : {}),
                  ...(Number.isSafeInteger(record.usage.completion_tokens) ? { outputTokens: record.usage.completion_tokens } : {}) };
              }
            } catch { measured.sseParseErrors += 1; }
          }
        }
        newline = buffer.indexOf('\n');
      }
    }
    measured.elapsedMs = Date.now() - startedAt;
    if (!measured.hasText && !measured.hasToolCalls) {
      // Same two shapes the product path distinguishes: thought that ended
      // without an answer is not a relay that sent nothing at all.
      measured.error = { classification: measured.hasReasoning ? 'reasoning_only' : 'empty_completion' };
    }
    return measured;
  } catch (error) {
    measured.elapsedMs = Date.now() - startedAt;
    measured.error = { classification: classifyFailure(error, measured.status) };
    return measured;
  } finally {
    clearTimeout(timer);
    active.count -= 1;
  }
}

function summarizeEndpoint(endpoint, results) {
  const completed = results.filter(result => !result.error);
  const tokens = { input: 0, output: 0, total: 0, reported: 0 };
  const finishes = {};
  for (const result of completed) {
    if (result.usage?.totalTokens !== undefined) {
      tokens.reported += 1;
      tokens.total += result.usage.totalTokens;
      tokens.input += result.usage.inputTokens ?? 0;
      tokens.output += result.usage.outputTokens ?? 0;
    }
    const reason = result.finishReason ?? 'unknown';
    finishes[reason] = (finishes[reason] ?? 0) + 1;
  }
  const failureCount = (classification) => results.filter(result => result.error?.classification === classification).length;
  return {
    name: endpoint.name,
    endpoint: (() => { try { return new URL(endpoint.baseUrl).origin; } catch { return 'invalid'; } })(),
    model: endpoint.model,
    attempted: results.length,
    completed: completed.length,
    failed: results.length - completed.length,
    provider_failures: results.filter(result => ['provider_http', 'network', 'timeout'].includes(result.error?.classification)).length,
    empty_completions: failureCount('empty_completion'),
    reasoning_only_completions: failureCount('reasoning_only'),
    parse_failures: results.filter(result => result.error?.classification === 'parse').length,
    requests_with_parse_errors: results.filter(result => result.sseParseErrors > 0).length,
    other_failures: results.filter(result => result.error && !['provider_http', 'network', 'timeout', 'empty_completion', 'reasoning_only', 'parse'].includes(result.error.classification)).length,
    elapsed_ms: distribution(results.map(result => result.elapsedMs).filter(Number.isFinite)),
    time_to_headers_ms: distribution(results.map(result => result.timeToHeadersMs).filter(Number.isFinite)),
    first_record_ms: distribution(results.map(result => result.timeToFirstRecordMs).filter(Number.isFinite)),
    finish_reasons: finishes,
    tokens: { ...tokens, complete: tokens.reported === results.length },
  };
}

/**
 * Run the interleaved comparison. Both endpoints receive byte-identical
 * request bodies; results are grouped by endpoint, never pooled.
 */
export async function compareEndpoints({ endpoints, body, requests, concurrency, timeoutMs = 300_000 }) {
  if (endpoints.length !== 2) throw new Error('exactly two endpoints are required');
  if (endpoints[0].model !== endpoints[1].model) throw new Error('both endpoints must use the same model alias');
  if (!Number.isSafeInteger(requests) || requests <= 0) throw new Error('requests must be a positive integer');
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) throw new Error('concurrency must be a positive integer');
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
  const parsed = JSON.parse(bodyText);
  if (parsed.model !== endpoints[0].model) throw new Error('request body model must equal the compared model alias');
  // Interleave A/B so slow periods hit both endpoints instead of one run each.
  const schedule = [];
  for (let round = 0; round < requests; round += 1) for (const endpoint of endpoints) schedule.push(endpoint);
  const results = new Map(endpoints.map(endpoint => [endpoint.name, []]));
  const active = { count: 0, max: 0 };
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= schedule.length) return;
      const endpoint = schedule[index];
      const result = await requestOnce(endpoint, bodyText, timeoutMs, active);
      results.get(endpoint.name).push(result);
    }
  };
  const startedAt = Date.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, schedule.length) }, worker));
  const report = {
    schema_version: 1,
    scope: 'per_request_only',
    note: 'Per-request wire latency only. Generation duration, agent work and research scores come from the benchmark artifacts; do not read this as total agent time.',
    model: endpoints[0].model,
    requests_per_endpoint: requests,
    concurrency,
    observed_max_in_flight: active.max,
    wall_ms: Date.now() - startedAt,
    request_body: {
      sha256: createHash('sha256').update(bodyText).digest('hex'),
      bytes: Buffer.byteLength(bodyText),
      // One string is sent to both endpoints, so identity holds by construction.
      identical_for_both: true,
    },
    endpoints: endpoints.map(endpoint => summarizeEndpoint(endpoint, results.get(endpoint.name))),
  };
  return report;
}

export function renderComparison(report) {
  const lines = ['### Model endpoint comparison', '',
    `model \`${report.model}\`; ${report.requests_per_endpoint} request(s) per endpoint; concurrency ${report.concurrency};`,
    `identical request body (sha256 ${report.request_body.sha256.slice(0, 12)}…, ${report.request_body.bytes} bytes).`, '',
    '| endpoint | requests | failures | p50 ms | p90 ms | p95 ms | p50 first record ms | total tokens |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  const value = (entry, key) => entry?.[key] ?? 'N/A';
  for (const endpoint of report.endpoints) {
    lines.push(`| ${endpoint.name} (${endpoint.endpoint}) | ${endpoint.attempted} | ${endpoint.failed} | ${value(endpoint.elapsed_ms, 'p50')} | ${value(endpoint.elapsed_ms, 'p90')} | ${value(endpoint.elapsed_ms, 'p95')} | ${value(endpoint.first_record_ms, 'p50')} | ${endpoint.tokens.complete ? endpoint.tokens.total : 'incomplete'} |`);
  }
  lines.push('', report.note);
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => { const at = args.indexOf(name); return at === -1 ? fallback : args[at + 1]; };
  const required = (name) => { const found = value(name); if (!found) throw new Error(`${name} is required`); return found; };
  const model = required('--model');
  const promptFile = value('--prompt-file');
  const bodyFile = value('--body-file');
  if (Boolean(promptFile) === Boolean(bodyFile)) throw new Error('pass exactly one of --prompt-file or --body-file');
  const body = bodyFile ? readFileSync(bodyFile, 'utf8') : JSON.stringify({
    model,
    messages: [{ role: 'user', content: readFileSync(promptFile, 'utf8') }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: Number(value('--max-tokens', '4096')),
  });
  const endpoint = (name, prefix) => ({ name, baseUrl: required(`--${prefix}-base-url`), model,
    token: value(`--${prefix}-token-env`) ? process.env[value(`--${prefix}-token-env`)] : undefined });
  const report = await compareEndpoints({
    endpoints: [endpoint(value('--a-name', 'a'), 'a'), endpoint(value('--b-name', 'b'), 'b')],
    body, requests: Number(value('--requests', '12')), concurrency: Number(value('--concurrency', '2')),
    timeoutMs: Number(value('--timeout-ms', '300000')),
  });
  const output = value('--out');
  if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(renderComparison(report));
}
