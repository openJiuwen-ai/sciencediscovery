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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { ToolTrace } from "../src/api/types.js";
import { formatToolInput, parseToolResultSections } from "../src/app/tool-io.js";
import { TEXT } from "../src/text.js";
import { mergePermissionSnapshot, permissionMatchingKey, pendingPermissions } from "../src/run-stream/permission.js";
import type { PermissionRequest } from "../src/api/types.js";

function trace(overrides: Partial<ToolTrace> = {}): ToolTrace {
  return { id: "c1", name: "run_python", status: "completed", ...overrides };
}

test("a single argument is shown as its bare value, not as JSON", () => {
  assert.equal(formatToolInput(trace({ args: { code: "print(1)" } })), "print(1)");
  // Not just strings: a lone non-string still comes out compact.
  assert.equal(formatToolInput(trace({ args: { limit: 5 } })), "5");
});

test("a primary text field is shown verbatim and the rest listed compactly", () => {
  const formatted = formatToolInput(trace({ args: { code: "print(1)", timeout: 30 } }));
  assert.equal(formatted, "print(1)\ntimeout: 30");
});

test("the primary field is picked by name, not by being first", () => {
  const formatted = formatToolInput(trace({ args: { timeout: 30, command: "ls -la" } }));
  assert.equal(formatted, "ls -la\ntimeout: 30");
});

test("arguments with no recognizable primary field fall back to the raw input", () => {
  const raw = '{"a":1,"b":2}';
  assert.equal(formatToolInput(trace({ args: { a: 1, b: 2 }, input: raw })), raw);
  // With no raw copy either, args are serialized — compactly, never prettified.
  assert.equal(formatToolInput(trace({ args: { a: 1, b: 2 } })), '{"a":1,"b":2}');
});

test("an absence of arguments falls back to the raw input, then to nothing", () => {
  assert.equal(formatToolInput(trace({ input: "verbatim" })), "verbatim");
  assert.equal(formatToolInput(trace({ args: {} })), undefined);
  assert.equal(formatToolInput(trace()), undefined);
});

test("a labeled execution result is split into sections", () => {
  const sections = parseToolResultSections("stdout: 3\nstderr: wobble", "completed");
  assert.deepEqual(sections, [
    { content: "3", id: "stdout", label: "stdout" },
    { content: "wobble", id: "stderr", label: "stderr" },
  ]);
});

test("text before the first marker becomes the residual result section", () => {
  const sections = parseToolResultSections("warming up\nstdout: 3", "completed");
  assert.equal(sections[0]!.id, "result");
  assert.equal(sections[0]!.content, "warming up");
  assert.equal(sections[1]!.id, "stdout");
});

test("the residual section is named 输出, or 错误 when the call failed", () => {
  // The residual text is what the runner never labelled, so its heading is UI
  // copy: it reads as the counterpart of 输入 rather than as a wire marker.
  const done = parseToolResultSections("warming up", "completed");
  assert.deepEqual(done, [{ content: "warming up", id: "result", label: TEXT.conversation.toolOutput }]);
  const failed = parseToolResultSections("traceback on line 4", "failed");
  assert.deepEqual(failed, [{ content: "traceback on line 4", id: "result", label: TEXT.conversation.toolError }]);
});

test("runner placeholders for an absent stream are dropped, not shown as data", () => {
  const sections = parseToolResultSections("stdout: (empty)\ncreated files: none", "completed");
  // Nothing real survived, so the raw text stands in rather than a blank card.
  assert.equal(sections.length, 1);
  assert.equal(sections[0]!.content, "stdout: (empty)\ncreated files: none");
});

test("a placeholder is dropped when a real section sits beside it", () => {
  const sections = parseToolResultSections("stdout: 3\nstderr: (empty)", "completed");
  assert.deepEqual(sections, [{ content: "3", id: "stdout", label: "stdout" }]);
});

test("created files are a section of their own", () => {
  const sections = parseToolResultSections("created files: a.csv\nb.csv", "completed");
  assert.deepEqual(sections, [{ content: "a.csv\nb.csv", id: "created-files", label: "Created files" }]);
});

test("whitespace-only output yields no sections at all", () => {
  assert.deepEqual(parseToolResultSections("   \n\n", "completed"), []);
});

test("a pending snapshot cannot resurrect a decided request", () => {
  const decided: PermissionRequest = {
    action: "sandbox", createdAt: "2026-01-01T00:00:00Z", decidedAt: "2026-01-01T00:00:05Z",
    decision: "deny", id: "p1", resource: "python:run", state: "denied", summary: "跑一段代码",
  };
  const pending: PermissionRequest = { ...decided, decidedAt: undefined, decision: undefined, state: "pending" };
  assert.equal(mergePermissionSnapshot(decided, pending).state, "denied");
  // And the other order — the decision arriving after the ask — does land.
  assert.equal(mergePermissionSnapshot(pending, decided).state, "denied");
});

test("among two decided snapshots the later decision wins", () => {
  const first: PermissionRequest = {
    action: "sandbox", createdAt: "2026-01-01T00:00:00Z", decidedAt: "2026-01-01T00:00:05Z",
    decision: "deny", id: "p1", resource: "python:run", state: "denied", summary: "跑一段代码",
  };
  const second: PermissionRequest = { ...first, decidedAt: "2026-01-01T00:00:09Z", decision: "allow_once", state: "allowed" };
  assert.equal(mergePermissionSnapshot(first, second).state, "allowed");
  assert.equal(mergePermissionSnapshot(second, first).state, "allowed");
});

test("only pending requests are offered buttons, and the summary is the link to the tool", () => {
  const base: PermissionRequest = {
    action: "sandbox", createdAt: "2026-01-01T00:00:00Z", id: "p1", resource: "python:run",
    state: "pending", summary: "跑一段代码", toolCallId: "c1",
  };
  const decided: PermissionRequest = { ...base, decision: "allow_once", id: "p2", state: "allowed" };
  const pending = pendingPermissions([{ request: base }, { request: decided }]);
  assert.deepEqual(pending.map((request) => request.id), ["p1"]);
});

test("a matching grant groups the requests it would cover", () => {
  const request = (action: PermissionRequest["action"], resource: string): PermissionRequest => ({
    action, createdAt: "2026-01-01T00:00:00Z", id: resource, resource, state: "pending", summary: "s",
  });
  // A connector grant covers the server, not one path on it.
  const mcp = request("connector", "mcp:github:read_file");
  assert.equal(permissionMatchingKey(mcp), permissionMatchingKey(request("connector", "mcp:github:write_file")));
  // A sandbox grant covers exactly the one resource.
  assert.notEqual(
    permissionMatchingKey(request("sandbox", "python:run")),
    permissionMatchingKey(request("sandbox", "shell:run")),
  );
});
