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

import { FEEDBACK_API_PATH, FEEDBACK_ENDPOINT, type FeedbackSubmission } from "@sciencediscovery/operational-logging/feedback";

import { submitFeedback } from "../src/feedback/submit.js";

const RECEIPT = "FB-ABCD-2345";

function submission(overrides: Partial<FeedbackSubmission> = {}): FeedbackSubmission {
  return {
    v: 1,
    kind: "bug",
    title: "Title",
    body: "This is a sufficiently long body.",
    clientTs: "2026-11-03T10:00:00.000Z",
    ...overrides,
  };
}

function json(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response;
}

test("posts to the shared endpoint and resolves a valid 201 receipt", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    seenUrl = String(url);
    seenInit = init;
    return json(201, { receipt: RECEIPT, createdAt: "2026-11-03T10:00:01.000Z" });
  };

  const result = await submitFeedback(submission(), { fetchImpl });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.receipt, RECEIPT);
    assert.equal(result.createdAt, "2026-11-03T10:00:01.000Z");
  }
  assert.equal(seenUrl, `${FEEDBACK_ENDPOINT}${FEEDBACK_API_PATH}`);
  assert.equal(seenInit?.method, "POST");
  assert.equal((seenInit?.body as string).includes('"kind":"bug"'), true);
});

test("a 201 without a valid receipt is treated as an unknown http failure", async () => {
  const fetchImpl = async (): Promise<Response> => json(201, { receipt: "not-a-receipt" });
  const result = await submitFeedback(submission(), { fetchImpl });
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.failure, { code: "http", status: 201 });
});

test("maps 400 to invalid with field errors", async () => {
  const fetchImpl = async (): Promise<Response> => json(400, { fields: { body: "min 10" } });
  const result = await submitFeedback(submission(), { fetchImpl });
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.failure, { code: "invalid", fields: { body: "min 10" } });
});

test("maps 409 to duplicate and carries the receipt", async () => {
  const withReceipt = await submitFeedback(submission(), { fetchImpl: async () => json(409, { receipt: RECEIPT }) });
  assert.equal(withReceipt.ok, false);
  if (!withReceipt.ok) assert.deepEqual(withReceipt.failure, { code: "duplicate", receipt: RECEIPT });

  const withoutReceipt = await submitFeedback(submission(), { fetchImpl: async () => json(409, {}) });
  assert.equal(withoutReceipt.ok, false);
  if (!withoutReceipt.ok) assert.deepEqual(withoutReceipt.failure, { code: "duplicate" });
});

test("maps remaining worker status codes", async () => {
  const cases: Array<[number, string]> = [
    [403, "forbidden"],
    [413, "too_large"],
    [429, "rate_limited"],
    [502, "upstream"],
    [503, "unavailable"],
  ];
  for (const [status, code] of cases) {
    const result = await submitFeedback(submission(), { fetchImpl: async () => json(status, {}) });
    assert.equal(result.ok, false, `status ${status}`);
    if (!result.ok) assert.deepEqual(result.failure, { code }, `status ${status}`);
  }
});

test("maps an unknown status code to http with the status", async () => {
  const result = await submitFeedback(submission(), { fetchImpl: async () => json(500, {}) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.failure, { code: "http", status: 500 });
});

test("a thrown non-abort error maps to network", async () => {
  const fetchImpl = async (): Promise<Response> => { throw new Error("connection refused"); };
  const result = await submitFeedback(submission(), { fetchImpl });
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.failure, { code: "network" });
});

test("an abort maps to timeout", async () => {
  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  const fetchImpl = async (): Promise<Response> => { throw abortError; };
  const result = await submitFeedback(submission(), { fetchImpl });
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.failure, { code: "timeout" });
});

test("a CJK report over the byte limit fails locally as too_large without a request", async () => {
  let called = false;
  const fetchImpl = async (): Promise<Response> => {
    called = true;
    return { status: 201, json: async () => ({ receipt: "FB-ABCD-2345" }) } as unknown as Response;
  };
  const result = await submitFeedback(
    submission({ body: "中".repeat(2000), diagnostics: "中".repeat(4000) }),
    { fetchImpl },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.failure, { code: "too_large" });
  assert.equal(called, false);
});