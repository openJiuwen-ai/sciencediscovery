// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createTest } from "../support/tagged/compat.mjs";
import { collectFinalDelivery } from "./real-delivery.ts";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });

function api(status = "completed", text = "[report](/artifact-versions/older/content)", content = "report", httpStatus = 200) {
  const paths: string[] = [];
  const data: Record<string, unknown> = {
    "/api/sessions/s/runs": [{ id: "r", assistantMessageId: "m", status }],
    "/api/sessions/s": { messages: [{ id: "m", role: "assistant", content: text }] },
    "/api/sessions/s/artifacts": [{ id: "a", logicalName: "nested/report.md" }],
    "/api/sessions/s/artifacts/a/versions": [{ id: "newer", version: 2 }, { id: "older", version: 1 }],
  };
  const page = { request: { get: async (url: string) => {
    const path = new URL(url).pathname; paths.push(path);
    return { ok: () => path.endsWith("/content") ? httpStatus === 200 : true, status: () => httpStatus,
      json: async () => data[path], body: async () => Buffer.from(content) };
  } } };
  return { page: page as never, paths };
}

test("delivery reads the immutable version explicitly referenced in the final response", async () => {
  const fake = api();
  const result = await collectFinalDelivery(fake.page, "s", "r");
  assert.equal(result.status, "passed");
  assert.equal(result.artifacts[0]?.version, "older");
  assert.ok(!fake.paths.some(p => p.includes("newer/content")));
});
test("empty or unreadable referenced output is a failed delivery", async () => {
  for (const [content, status] of [["   ", 200], ["report", 404]] as const) {
    const fake = api("completed", "nested/report.md", content, status);
    const result = await collectFinalDelivery(fake.page, "s", "r");
    assert.equal(result.status, "failed");
    assert.equal(result.errors.length, 1);
  }
});
test("a failed agent with a real final artifact is recorded as partial, never passed", async () => {
  const fake = api("failed");
  assert.equal((await collectFinalDelivery(fake.page, "s", "r")).status, "partial");
});
