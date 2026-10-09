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

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createTest } from "../support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

import { compareRecordings, coverage, lookup, profileRunEvents, runCase } from "./lib.mjs";

async function fakeBackend(handler) {
  const seen = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    seen.push({ method: request.method, url: request.url, auth: request.headers.authorization, body });
    handler(request, response, body, seen);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
const json = (response, status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };

test("lookup follows dotted paths and indexes", () => {
  assert.equal(lookup({ a: { b: [{ c: 7 }] } }, "$.a.b[0].c"), 7);
  assert.equal(lookup({}, "$.missing.deeper"), undefined);
});

test("a case captures ids into later requests, sends the token and normalises the answers", async () => {
  const backend = await fakeBackend((request, response, body) => {
    if (request.method === "POST") json(response, 201, { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", createdAt: "2026-01-01T00:00:00Z" });
    else json(response, 200, { echoed: request.url });
  });
  try {
    const records = await runCase({ id: "c", steps: [
      { name: "create", request: { method: "POST", path: "/things", body: { n: 1 } }, capture: { thingId: "$.id" }, expectStatus: 201 },
      { name: "read", request: { method: "GET", path: "/things/{{thingId}}" }, expectStatus: 200 },
    ] }, { base: backend.base, token: "tok" });
    assert.equal(backend.seen[0].auth, "Bearer tok");
    assert.deepEqual(backend.seen[0].body, { n: 1 });
    assert.equal(backend.seen[1].url, "/things/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert.deepEqual(records[0].body, { createdAt: "<time>", id: "<uuid:1>" });
    assert.deepEqual(records[1].body, { echoed: "/things/<uuid:1>" });
    assert.equal(records.every((record) => !record.error), true);
  } finally {
    await backend.close();
  }
});

test("a failed expectation stops the case, but cleanup steps still run", async () => {
  const backend = await fakeBackend((request, response) => json(response, request.method === "GET" ? 500 : 200, {}));
  try {
    const records = await runCase({ id: "c", steps: [
      { name: "read", request: { method: "GET", path: "/a" }, expectStatus: 200 },
      { name: "skipped", request: { method: "GET", path: "/b" } },
      { name: "cleanup", request: { method: "DELETE", path: "/c" }, always: true },
    ] }, { base: backend.base, token: "t" });
    assert.deepEqual(records.map((record) => record.name), ["read", "cleanup"]);
    assert.match(records[0].error, /expected status 200, got 500/);
    assert.deepEqual(backend.seen.map((request) => request.url), ["/a", "/c"]);
  } finally {
    await backend.close();
  }
});

test("a variable that was never captured is a clear error, not a request to /undefined", async () => {
  const backend = await fakeBackend((request, response) => json(response, 200, {}));
  try {
    const records = await runCase({ id: "c", steps: [{ name: "x", request: { method: "GET", path: "/{{nope}}" } }] }, { base: backend.base, token: "t" });
    assert.match(records[0].error, /\{\{nope\}\} was never captured/);
    assert.equal(backend.seen.length, 0);
  } finally {
    await backend.close();
  }
});

test("server-sent events are collected until the stop event", async () => {
  const backend = await fakeBackend((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"type":"run.started"}\n\n');
    response.write('data: {"type":"assistant.delta","delta":"hi"}\n\n');
    response.write('data: {"type":"run.completed"}\n\n');
    response.write('data: {"type":"after"}\n\n');
  });
  try {
    const [record] = await runCase({ id: "c", steps: [{ name: "stream", request: { method: "GET", path: "/events" }, stream: { until: ["run.completed"] } }] },
      { base: backend.base, token: "t" });
    assert.deepEqual(record.events.map((event) => event.type), ["run.started", "assistant.delta", "run.completed"]);
  } finally {
    await backend.close();
  }
});

test("comparing recordings names each difference and a missing case", () => {
  const baseline = { a: [{ name: "s", status: 200, body: { n: 1 } }], b: [{ name: "t", status: 200 }] };
  const actual = { a: [{ name: "s", status: 200, body: { n: 2 } }] };
  assert.deepEqual(compareRecordings(baseline, actual), ['a / s: $.body.n expected 1 got 2', "b: case was not run"]);
  assert.deepEqual(compareRecordings(baseline, baseline), []);
});

test("coverage counts rows with a case, exempts not-migrated ones and flags unknown keys", () => {
  const routes = { rows: [
    { domain: "d", method: "GET", path: "/a", handling: "direct" },
    { domain: "d", method: "GET", path: "/b", handling: "adapter" },
    { domain: "d", method: "GET", path: "/legacy", handling: "not-migrated" },
  ] };
  const cases = [{ steps: [{ covers: ["GET /a", "GET /typo"] }] }];
  const report = coverage(routes, cases);
  assert.equal(report.covered, 1);
  assert.equal(report.exempt, 1);
  assert.deepEqual(report.missing.map((row) => row.key), ["GET /b"]);
  assert.deepEqual(report.unknown, ["GET /typo"]);
});

test("a variable that is the whole value keeps its type, so a captured object is sent back as an object", async () => {
  const backend = await fakeBackend((request, response) => json(response, 200, { overrides: { a: 1, list: [1, 2] } }));
  try {
    await runCase({ id: "c", steps: [
      { name: "read", request: { method: "GET", path: "/settings" }, capture: { original: "$.overrides" } },
      { name: "restore", request: { method: "PUT", path: "/settings", body: "{{original}}" } },
    ] }, { base: backend.base, token: "t" });
    assert.deepEqual(backend.seen[1].body, { a: 1, list: [1, 2] });
  } finally {
    await backend.close();
  }
});

test("a poll step waits for the condition and records only the final value", async () => {
  let calls = 0;
  const backend = await fakeBackend((request, response) => json(response, 200, { status: ++calls < 3 ? "running" : "completed" }));
  try {
    const [record] = await runCase({ id: "c", steps: [{
      name: "settle", request: { method: "GET", path: "/run" }, poll: { path: "\$.status", in: ["completed"], timeoutMs: 5000 },
    }] }, { base: backend.base, token: "t" });
    assert.deepEqual(record, { name: "settle", status: 200, polled: "completed" });
    assert.equal(calls, 3);
  } finally {
    await backend.close();
  }
});

test("a poll that never reaches its condition is an error, not a hang", async () => {
  const backend = await fakeBackend((request, response) => json(response, 200, { status: "running" }));
  try {
    const [record] = await runCase({ id: "c", steps: [{
      name: "settle", request: { method: "GET", path: "/run" }, poll: { path: "\$.status", in: ["completed"], timeoutMs: 400 },
    }] }, { base: backend.base, token: "t" });
    assert.match(record.error, /still "running"/);
  } finally {
    await backend.close();
  }
});

test("the run-event profile joins text fragments, drops agent evidence and collapses step snapshots", () => {
  const raw = [
    { event: { type: "agent.record", name: "context.captured" } },
    { event: { type: "assistant.delta", delta: "Hel", responseId: "r", evidence: { turn: 1 } } },
    { event: { type: "assistant.delta", delta: "lo", responseId: "r" } },
    { event: { type: "assistant.delta", delta: "!", responseId: "other" } },
    { event: { type: "subagent.step", step: { id: "s1", content: "do" } } },
    { event: { type: "subagent.step", step: { id: "s1", content: "done" } } },
    { event: { type: "subagent.step", step: { id: "s2", content: "next" } } },
  ];
  assert.deepEqual(profileRunEvents(raw), [
    { type: "assistant.delta", delta: "Hello", responseId: "r" },
    { type: "assistant.delta", delta: "!", responseId: "other" },
    { type: "subagent.step", step: { id: "s1", content: "done" } },
    { type: "subagent.step", step: { id: "s2", content: "next" } },
  ]);
});

test("an accepted difference is reported with its reason instead of failing the comparison", () => {
  const baseline = { a: [{ name: "run events", events: [{ type: "run.failed", error: "provider says no" }, { type: "x", n: 1 }] }] };
  const actual = { a: [{ name: "run events", events: [{ type: "run.failed", error: "JiuwenSwarm says no" }, { type: "x", n: 2 }] }] };
  const rules = [{ case: "a", step: "run events", path: "$.events[*].error", reason: "wording of the provider error" }];
  const report = { accepted: [] };
  assert.deepEqual(compareRecordings(baseline, actual, rules, report), ["a / run events: $.events[1].n expected 1 got 2"]);
  assert.deepEqual(report.accepted, ["a / run events: $.events[0].error (wording of the provider error)"]);
});

test("a rule for one case or step does not excuse the same path elsewhere, and brackets are literal", () => {
  const baseline = { a: [{ name: "s", list: [1] }], b: [{ name: "s", list: [1] }] };
  const actual = { a: [{ name: "s", list: [2] }], b: [{ name: "s", list: [2] }] };
  const rules = [{ case: "a", step: "s", path: "$.list[0]", reason: "only here" }];
  assert.deepEqual(compareRecordings(baseline, actual, rules), ["b / s: $.list[0] expected 1 got 2"]);
});
