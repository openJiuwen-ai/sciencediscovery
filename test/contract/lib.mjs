//!/usr/bin/env bash
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

/**
 * L1 contract scenarios: replay a scripted list of HTTP requests against a backend,
 * record what came back (normalised), and compare a run against a stored baseline.
 * No browser and no model: it checks the interface, not the agent.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT, createNormalizer, diff, scrubValue } from "./normalize.mjs";
import { startStubModel } from "./stub-model.mjs";

export function loadCases(directory) {
  return readdirSync(directory).filter((name) => name.endsWith(".json")).sort()
    .flatMap((name) => JSON.parse(readFileSync(join(directory, name), "utf8")).cases
      .map((testCase) => ({ ...testCase, file: name })));
}

/** $.a.b[0] style lookups, enough for capturing ids out of a response. */
export function lookup(value, expression) {
  const parts = expression.replace(/^\$\.?/, "").split(/[.\[\]]+/).filter(Boolean);
  return parts.reduce((current, part) => (current === undefined || current === null ? undefined : current[part]), value);
}

function substitute(value, variables) {
  if (typeof value === "string") {
    // A value that is exactly one variable keeps its type, so a captured object can be sent back whole.
    const whole = value.match(/^\{\{(\w+)\}\}$/);
    if (whole && whole[1] in variables) return variables[whole[1]];
    return value.replace(/\{\{(\w+)\}\}/g, (_, name) => {
      if (!(name in variables)) throw new Error(`variable {{${name}}} was never captured`);
      return String(variables[name]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, variables));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, variables)]));
  return value;
}

async function readSse(response, stream, onEvent = async () => undefined) {
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + (stream.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ done: true }), Math.max(1, deadline - Date.now()))),
    ]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let boundary = buffer.indexOf("\n\n"); boundary >= 0; boundary = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data) continue;
      try { events.push(JSON.parse(data)); } catch { events.push({ raw: data }); }
      const last = events[events.length - 1];
      const type = last?.event?.type ?? last?.type;
      await onEvent(last, type);
      if (stream.until?.includes(type) || events.length >= (stream.maxEvents ?? 1_000)) {
        await reader.cancel().catch(() => undefined);
        return events;
      }
    }
  }
  await reader.cancel().catch(() => undefined);
  return events;
}

/**
 * The run-event profile: what a user could see, in a form that does not depend on timing.
 * Consecutive text/thinking/tool-output fragments of one response are joined (how many
 * fragments arrive is a matter of timing, as is how many snapshots of one subagent step), envelope fields that only count or time events
 * are dropped, and the native agent's own evidence (`agent.record` and each event's
 * `evidence`) is left out: it is not part of what another executor has to reproduce.
 */
export function profileRunEvents(events) {
  const out = [];
  const JOINED = { "assistant.delta": "delta", "assistant.thinking.delta": "delta", "tool.output": "chunk" };
  for (const wrapper of events) {
    const { evidence, ...event } = wrapper.event ?? wrapper;
    if (event.type === "agent.record") continue;
    const field = JOINED[event.type];
    const previous = out[out.length - 1];
    // A step being streamed is re-sent as a snapshot each time a coalescing timer fires; how many
    // snapshots arrive is timing, so consecutive ones for the same step collapse to the last.
    if (event.type === "subagent.step" && previous?.type === "subagent.step" && previous.step?.id === event.step?.id) {
      out[out.length - 1] = event;
      continue;
    }
    const sameStream = previous && previous.type === event.type
      && (previous.responseId ?? previous.toolCallId) === (event.responseId ?? event.toolCallId);
    if (field && sameStream) previous[field] += event[field];
    else out.push(event);
  }
  return out;
}

/** Run one case; returns one record per step. Steps marked always:true run even after a failure. */
export async function runCase(testCase, { base, token, fetchImpl = fetch }) {
  const normalize = createNormalizer();
  const variables = { repoRoot: REPO_ROOT, baseUrl: base };
  // A case that needs a model gets its own scripted stub, so every case starts from step one.
  const stub = testCase.stub ? await startStubModel(testCase.stub) : undefined;
  if (stub) Object.assign(variables, { stubBaseUrl: stub.baseUrl, stubModel: stub.model, stubToken: stub.apiToken });
  try {
    return await runSteps(testCase, { base, token, fetchImpl, normalize, variables });
  } finally {
    await stub?.stop();
  }
}

async function runSteps(testCase, { base, token, fetchImpl, normalize, variables }) {
  const records = [];
  let failed = false;
  for (const step of testCase.steps) {
    if (failed && !step.always) continue;
    const record = { name: step.name };
    try {
      const request = substitute(step.request, variables);
      const response = await fetchImpl(`${base}${request.path}`, {
        method: request.method,
        headers: { authorization: `Bearer ${token}`, ...(request.body !== undefined ? { "content-type": "application/json" } : {}), ...(request.headers ?? {}) },
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      });
      if (step.poll) {
        // Wait for a condition in the answer (e.g. a run reaching a terminal state); only the
        // final value is recorded, since how many polls it took is timing.
        const deadline = Date.now() + (step.poll.timeoutMs ?? 30_000);
        let current = response;
        let parsed = await current.json().catch(() => undefined);
        while (!step.poll.in.includes(lookup(parsed, step.poll.path)) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          current = await fetchImpl(`${base}${request.path}`, { method: request.method, headers: { authorization: `Bearer ${token}` } });
          parsed = await current.json().catch(() => undefined);
        }
        record.status = current.status;
        record.polled = lookup(parsed, step.poll.path);
        if (!step.poll.in.includes(record.polled)) record.error = `still ${JSON.stringify(record.polled)} after ${step.poll.timeoutMs ?? 30_000} ms`;
        records.push(record);
        continue;
      }
      record.status = response.status;
      record.contentType = (response.headers.get("content-type") ?? "").split(";")[0];
      if (step.stream) {
        const reactionErrors = [];
        const send = async (reaction) => {
          const follow = substitute(reaction.request, variables);
          const answer = await fetchImpl(`${base}${follow.path}`, {
            method: follow.method,
            headers: { authorization: `Bearer ${token}`, ...(follow.body !== undefined ? { "content-type": "application/json" } : {}) },
            ...(follow.body !== undefined ? { body: JSON.stringify(follow.body) } : {}),
          });
          // A reaction that fails would otherwise look like a run that never continued.
          if (!answer.ok) reactionErrors.push(`${follow.method} ${follow.path} -> ${answer.status} ${(await answer.text()).slice(0, 200)}`);
        };
        const fired = new Set();
        const raw = await readSse(response, step.stream, async (event, type) => {
          for (const [index, reaction] of (step.stream.reactions ?? []).entries()) {
            if (reaction.when !== type || fired.has(index)) continue;
            fired.add(index);
            for (const [name, expression] of Object.entries(reaction.capture ?? {})) variables[name] = lookup(event.event ?? event, expression);
            await send(reaction);
          }
        });
        for (const [name, expression] of Object.entries(step.capture ?? {})) variables[name] = lookup({ events: raw, last: raw[raw.length - 1] }, expression);
        if (reactionErrors.length) record.error = `reaction failed: ${reactionErrors.join("; ")}`;
        const shown = step.stream.profile === "run-events" ? profileRunEvents(raw) : raw;
        record.events = shown.map((event) => normalize.json(event));
      } else {
        const raw = await response.text();
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
        if (parsed !== undefined) {
          for (const [name, expression] of Object.entries(step.capture ?? {})) variables[name] = lookup(parsed, expression);
          record.body = normalize.json(parsed);
        } else if (raw) {
          record.text = normalize.text(raw).slice(0, 2_000);
        }
      }
      if (step.expectStatus !== undefined && response.status !== step.expectStatus) {
        record.error = `expected status ${step.expectStatus}, got ${response.status}`;
        failed = true;
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      failed = true;
    }
    records.push(record);
  }
  return records;
}

export async function runAll(cases, options) {
  const result = {};
  for (const testCase of cases) result[testCase.id] = await runCase(testCase, options);
  return result;
}

/** `$.events[*].error` matches `$.events[7].error`; a rule names the case and the step it is about. */
function pathMatches(pattern, path) {
  const source = pattern.split("[*]")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"))
    .join("\\[\\d+\\]");
  return new RegExp(`^${source}$`).test(path);
}

/**
 * Differences between a baseline recording and a fresh one, as readable lines. A difference that
 * an `accepted` rule covers ({ case, step, path, reason }) is not a problem; it is returned in
 * `accepted` with its reason, so the list of tolerated divergences stays visible.
 */
export function compareRecordings(baseline, actual, accepted = [], report = { accepted: [] }) {
  const problems = [];
  // Both sides are scrubbed again, so a rule added after the baseline was recorded still applies to it.
  baseline = scrubValue(baseline);
  actual = scrubValue(actual);
  for (const [id, expectedSteps] of Object.entries(baseline)) {
    const actualSteps = actual[id];
    if (!actualSteps) { problems.push(`${id}: case was not run`); continue; }
    expectedSteps.forEach((expected, index) => {
      const got = actualSteps[index];
      if (!got) { problems.push(`${id} / ${expected.name}: step missing`); return; }
      for (const difference of diff(expected, got)) {
        const rule = accepted.find((item) => item.case === id && item.step === expected.name && pathMatches(item.path, difference.path));
        if (rule) { report.accepted.push(`${id} / ${expected.name}: ${difference.path} (${rule.reason})`); continue; }
        problems.push(`${id} / ${expected.name}: ${difference.path} expected ${JSON.stringify(difference.expected)} got ${JSON.stringify(difference.actual)}`);
      }
    });
  }
  return problems;
}

/** Coverage of the interface inventory by the cases; rows marked not-migrated need none. */
export function coverage(routes, cases) {
  const covered = new Set(cases.flatMap((testCase) => testCase.steps.flatMap((step) => step.covers ?? [])));
  const rows = routes.rows.map((row) => ({ ...row, key: `${row.method} ${row.path}`, exempt: row.handling === "not-migrated" }));
  const unknown = [...covered].filter((key) => !rows.some((row) => row.key === key));
  return {
    unknown,
    total: rows.length,
    exempt: rows.filter((row) => row.exempt).length,
    covered: rows.filter((row) => !row.exempt && covered.has(row.key)).length,
    missing: rows.filter((row) => !row.exempt && !covered.has(row.key)),
  };
}
