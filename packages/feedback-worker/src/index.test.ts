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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { RECEIPT_PATTERN } from "@sciencediscovery/operational-logging/feedback";
import { handleRequest, type KVNamespaceLike, type WorkerEnv, type FeedbackDeps } from "./index.js";

const NOW = new Date("2026-11-03T10:00:00Z");

class MemoryKV implements KVNamespaceLike {
  readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

function makeEnv(): WorkerEnv {
  return {
    FEEDBACK_KV: new MemoryKV(),
    GITHUB_TOKEN: "secret-token",
    REPO_OWNER: "owner",
    REPO_NAME: "repo",
    DAILY_ISSUE_LIMIT: "200",
  };
}

function makeFetch(status = 201): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  // RequestInfo is a DOM type and this file is type-checked without the DOM lib.
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init! });
    return new Response(JSON.stringify({ number: 1, html_url: "https://github.com/owner/repo/issues/1" }), { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const validSubmission = {
  v: 1,
  kind: "bug",
  title: "模型连接反复超时",
  body: "在 Windows 上跑单测时模型连接反复超时，大约每三次出现一次。",
  meta: { installId: "inst-1", version: "0.3.0", os: "win32 x64", locale: "zh-CN" },
  clientTs: "2026-11-03T09:59:00Z",
};

function post(body: unknown, opts: { origin?: string | null; ip?: string } = {}): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (opts.origin != null) headers.set("Origin", opts.origin);
  if (opts.ip) headers.set("CF-Connecting-IP", opts.ip);
  return new Request("https://feedback.science.test/api/feedback", { method: "POST", headers, body: JSON.stringify(body) });
}

const deps: FeedbackDeps = { now: () => NOW };

test("CORS preflight echoes the allowed origin and rejects the rest", async () => {
  const env = makeEnv();
  const ok = await handleRequest(new Request("https://feedback.science.test/api/feedback", { method: "OPTIONS", headers: { Origin: "http://127.0.0.1:4310" } }), env);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), "http://127.0.0.1:4310");
  assert.equal(ok.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");

  const forbidden = await handleRequest(new Request("https://feedback.science.test/api/feedback", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), env);
  assert.equal(forbidden.status, 403);
});

test("a disallowed Origin on POST returns 403 but a missing Origin is allowed", async () => {
  const env = makeEnv();
  const { fetchImpl } = makeFetch();
  const blocked = await handleRequest(post(validSubmission, { origin: "https://evil.example" }), env, { fetchImpl, now: () => NOW });
  assert.equal(blocked.status, 403);

  const allowed = await handleRequest(post(validSubmission, { origin: null }), env, { fetchImpl, now: () => NOW });
  assert.equal(allowed.status, 201);
});

test("oversized bodies are rejected with 413 before parsing", async () => {
  const env = makeEnv();
  const big = new Request("https://feedback.science.test/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "x".repeat(20 * 1024),
  });
  const res = await handleRequest(big, env, deps);
  assert.equal(res.status, 413);
});

test("invalid JSON and invalid fields return 400 with reasons", async () => {
  const env = makeEnv();
  const badJson = new Request("https://feedback.science.test/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json" });
  assert.equal((await handleRequest(badJson, env, deps)).status, 400);

  const tooShort = await handleRequest(post({ ...validSubmission, body: "short" }), env, deps);
  assert.equal(tooShort.status, 400);
  assert.deepEqual(await tooShort.json(), { error: "invalid", fields: { body: "min 10" } });
});

test("a successful submission creates a GitHub issue and returns a receipt", async () => {
  const env = makeEnv();
  const { fetchImpl, calls } = makeFetch();
  const res = await handleRequest(post(validSubmission), env, { fetchImpl, now: () => NOW });
  assert.equal(res.status, 201);
  const body = await res.json() as { receipt: string; createdAt: string };
  assert.match(body.receipt, RECEIPT_PATTERN);
  assert.equal(body.createdAt, "2026-11-03T10:00:00.000Z");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.github.com/repos/owner/repo/issues");
  const init = calls[0]!.init;
  assert.equal((init.headers as Record<string, string>).Authorization, "Bearer secret-token");
  const sent = JSON.parse(init.body as string) as { title: string; body: string; labels: string[] };
  assert.ok(sent.title.startsWith(`[${body.receipt}]`));
  assert.ok(sent.body.includes("<!-- sd-feedback:v1 -->"));
  assert.ok(sent.labels.includes("kind:bug"));
  assert.ok(sent.labels.includes("source:in-app"));
  assert.ok(sent.labels.includes("needs-triage"));
});

test("a duplicate within the window returns 409 with the original receipt", async () => {
  const env = makeEnv();
  const { fetchImpl } = makeFetch();
  const first = await handleRequest(post(validSubmission), env, { fetchImpl, now: () => NOW });
  const firstBody = await first.json() as { receipt: string };

  const second = await handleRequest(post(validSubmission), env, { fetchImpl, now: () => NOW });
  assert.equal(second.status, 409);
  const secondBody = await second.json() as { error: string; receipt: string };
  assert.equal(secondBody.error, "duplicate");
  assert.equal(secondBody.receipt, firstBody.receipt);
});

test("two reporters sending identical text each get their own issue and receipt", async () => {
  const env = makeEnv();
  const { fetchImpl, calls } = makeFetch();
  const first = await handleRequest(post(validSubmission), env, { fetchImpl, now: () => NOW });
  const second = await handleRequest(
    post({ ...validSubmission, meta: { ...validSubmission.meta, installId: "inst-2" } }),
    env,
    { fetchImpl, now: () => NOW },
  );
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const firstBody = await first.json() as { receipt: string };
  const secondBody = await second.json() as { receipt: string };
  assert.notEqual(firstBody.receipt, secondBody.receipt);
  assert.equal(calls.length, 2);
});

test("a wrongly typed field is a 400 naming the field, not a 500", async () => {
  const res = await handleRequest(post({ ...validSubmission, body: 42 }), makeEnv(), deps);
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string; fields: Record<string, string> };
  assert.equal(body.error, "invalid");
  assert.ok(body.fields.body);
});

test("a 422 on the labels retries without them instead of losing the report", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const statuses = [422, 201];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init! });
    const status = statuses.shift() ?? 201;
    return new Response(JSON.stringify({ number: 7, html_url: "https://github.com/owner/repo/issues/7" }), { status });
  }) as typeof fetch;

  const res = await handleRequest(post(validSubmission), makeEnv(), { fetchImpl, now: () => NOW });

  assert.equal(res.status, 201);
  assert.equal(calls.length, 2);
  const firstBody = JSON.parse(String(calls[0]!.init.body)) as { labels?: string[] };
  const retryBody = JSON.parse(String(calls[1]!.init.body)) as { labels?: string[] };
  assert.ok(firstBody.labels && firstBody.labels.length > 0);
  assert.equal(retryBody.labels, undefined);
});

test("installId daily limit returns 429 on the sixth submission (AC-24)", async () => {
  const env = makeEnv();
  await env.FEEDBACK_KV.put("rl:install:2026-11-03:inst-1", "5", { expirationTtl: 86400 });
  const res = await handleRequest(post(validSubmission), env, deps);
  assert.equal(res.status, 429);
});

test("daily issue guardrail returns 503 once the quota is exhausted", async () => {
  const env = makeEnv();
  await env.FEEDBACK_KV.put("quota:issues:2026-11-03", "200", { expirationTtl: 86400 });
  const res = await handleRequest(post(validSubmission), env, deps);
  assert.equal(res.status, 503);
});

test("a GitHub 5xx surfaces 502 without leaking the token", async () => {
  const env = makeEnv();
  const { fetchImpl } = makeFetch(500);
  const res = await handleRequest(post(validSubmission), env, { fetchImpl, now: () => NOW });
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.ok(!text.includes("secret-token"));
});