// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTest } from "../support/tagged/compat.mjs";
import { measureSession, writeCaseMetrics } from "./case-measurements.ts";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });

const root = fileURLToPath(new URL("../../", import.meta.url));
const file = "journey-basic-real-api.spec.ts", title = "L3-response: Short response and stream completion";
const id = `playwright:test/${file}::real/${file}/${encodeURIComponent(title)}`;

function workspace(t: { after: (fn: () => void) => void }) {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "case-measurements-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function testInfo(dir: string, timeout: number) {
  const timeouts: number[] = [];
  const info = { timeout, file: join(root, "test", file), project: { name: "real" }, titlePath: [file, title],
    outputPath: (name: string) => join(dir, name),
    setTimeout(ms: number) { timeouts.push(ms); info.timeout = ms; } };
  return { info: info as never, timeouts, current: () => info.timeout };
}
function request(routes: Record<string, unknown>) {
  return { get: async (url: string) => {
    const path = new URL(url).pathname;
    if (!(path in routes)) return { ok: () => false, status: () => 404, json: async () => ({ error: "PRIVATE_FIXTURE" }) };
    return { ok: () => true, status: () => 200, json: async () => structuredClone(routes[path]) };
  } } as never;
}
const routes = {
  "/api/sessions/s/usage": { totals: { invocationCount: 1 },
    invocations: [{ usageStatus: "reported", inputTokens: 20000, outputTokens: 70006, totalTokens: 90006, model: "PRIVATE_FIXTURE" }] },
  "/api/sessions/s/runs": [{ id: "r1", prompt: "PRIVATE_FIXTURE" }],
  "/api/sessions/s/subagents": [],
  "/api/sessions/s/runs/r1/events": [{ event: { type: "tool.started", trace: { id: "t1", input: "PRIVATE_FIXTURE" } } }],
};

test("collection gives its time back to the test and never throws", async t => {
  const dir = workspace(t);
  const failing = testInfo(dir, 1_000);
  const rejecting = { get: async () => { throw new Error("PRIVATE_FIXTURE connection reset"); } } as never;
  assert.deepEqual(await measureSession(rejecting, failing.info, "s"), {});
  // Extended for the collection, then left at the original budget plus the time it took.
  assert.equal(failing.timeouts[0], 61_000);
  assert.ok(failing.current() >= 1_000 && failing.current() < 11_000, String(failing.current()));
  const unlimited = testInfo(dir, 0);
  assert.deepEqual(await measureSession(request(routes), unlimited.info, "s"), { generation_output_tokens: 70006, total_tokens: 90006, tool_calls: 1 });
  assert.deepEqual(unlimited.timeouts, [], "an unlimited test stays unlimited");
});

test("case-metrics.json holds the plan identity and numbers only", async t => {
  const dir = workspace(t), plan = join(dir, "plan.json");
  const previous = process.env.SCIENCE_TAG_PLAN;
  t.after(() => { if (previous === undefined) delete process.env.SCIENCE_TAG_PLAN; else process.env.SCIENCE_TAG_PLAN = previous; });
  delete process.env.SCIENCE_TAG_PLAN;
  await writeCaseMetrics(request(routes), testInfo(dir, 1_000).info, "s");
  const text = readFileSync(join(dir, "case-metrics.json"), "utf8");
  assert.doesNotMatch(text, /PRIVATE_FIXTURE/);
  assert.deepEqual(JSON.parse(text), { schema_version: 1, case: id,
    measurements: { generation_output_tokens: 70006, total_tokens: 90006, tool_calls: 1 } });
  writeFileSync(plan, JSON.stringify({ entries: [{ id, key: `${id}@linux/amd64#jiuwenswarm`, source: `test/${file}` }] }));
  process.env.SCIENCE_TAG_PLAN = plan;
  await writeCaseMetrics(request({}), testInfo(dir, 1_000).info, "s");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "case-metrics.json"), "utf8")),
    { schema_version: 1, case: id, key: `${id}@linux/amd64#jiuwenswarm`, measurements: {} });
});
