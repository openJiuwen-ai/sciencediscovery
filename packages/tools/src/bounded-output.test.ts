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

import assert from "node:assert/strict";
import test from "node:test";

import {
  boundText,
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  formatByteSize,
  splitKeepingLineEndings,
  ToolOutputGuard,
  type ToolOutputRecord,
} from "./bounded-output.js";

const record = (overrides: Partial<ToolOutputRecord> = {}): ToolOutputRecord => ({
  bytes: 4_000,
  droppedBytes: 0,
  lines: 100,
  ref: "tool-output-00112233445566aa",
  toolName: "mcp__pubmed__search",
  ...overrides,
});

test("a result inside the bounds is returned unchanged", () => {
  const bounded = boundText("one\ntwo\nthree\n");
  assert.equal(bounded.truncated, false);
  assert.equal(bounded.text, "one\ntwo\nthree\n");
  assert.equal(bounded.totalLines, 3);
  assert.equal(bounded.omittedLines, 0);
});

test("splitting keeps line terminators so a rejoin is lossless", () => {
  assert.deepEqual(splitKeepingLineEndings("a\nb\n"), ["a\n", "b\n"]);
  assert.deepEqual(splitKeepingLineEndings("a\nb"), ["a\n", "b"]);
  assert.deepEqual(splitKeepingLineEndings(""), []);
  const text = "alpha\r\nbeta\ngamma";
  assert.equal(splitKeepingLineEndings(text).join(""), text);
});

test("the head bound keeps the first lines and reports what it dropped", () => {
  const text = Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n");
  const bounded = boundText(text, { maxLines: 10 });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.totalLines, 100);
  assert.equal(bounded.omittedLines, 90);
  assert.equal(bounded.text.startsWith("line-0\n"), true);
  assert.equal(bounded.text.includes("line-9"), true);
  assert.equal(bounded.text.includes("line-10\n"), false);
});

test("the tail bound keeps the last lines, where an exit status lives", () => {
  const text = Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n");
  const bounded = boundText(text, { keep: "tail", maxLines: 3 });
  assert.equal(bounded.keep, "tail");
  assert.equal(bounded.text, "line-97\nline-98\nline-99");
  assert.equal(bounded.omittedLines, 97);
});

test("one line wider than the budget is cut on a character boundary", () => {
  const bounded = boundText(`${"漢".repeat(1_000)}\ntail`, { maxBytes: 100 });
  assert.equal(bounded.truncated, true);
  // Each character is 3 bytes, so 33 fit inside 100 bytes with no partial byte.
  assert.equal(bounded.text, "漢".repeat(33));
  assert.equal(Buffer.byteLength(bounded.text, "utf8"), 99);
});

test("byte size formatting stays locale-independent", () => {
  assert.equal(formatByteSize(512), "512 B");
  assert.equal(formatByteSize(51_200), "50.0 KB");
  assert.equal(formatByteSize(3 * 1_024 * 1_024), "3.0 MB");
});

test("the guard leaves a small result untouched and stores nothing", async () => {
  const saved: string[] = [];
  const guard = new ToolOutputGuard({
    sink: { async save(toolName, text) { saved.push(toolName); return record({ bytes: text.length }); } },
  });
  assert.equal(await guard.apply("read_file", "small result"), "small result");
  assert.deepEqual(saved, []);
});

test("the guard replaces an oversized result with a preview plus a re-read ref", async () => {
  const guard = new ToolOutputGuard({
    sink: { async save() { return record({ lines: 60_000, ref: "tool-output-0123456789abcdef" }); } },
  });
  const text = `${"x".repeat(200)}\n`.repeat(60_000);
  const result = await guard.apply("mcp__pubmed__search", text);

  assert.ok(Buffer.byteLength(result, "utf8") < DEFAULT_TOOL_OUTPUT_MAX_BYTES * 1.1, "result fits the model-facing bound");
  assert.match(result, /^\[bounded tool output] mcp__pubmed__search produced 60000 lines \(11\.5 MB\)\./);
  assert.match(result, /read_tool_output\(ref="tool-output-0123456789abcdef", offset=<1-based line>, limit=<lines>\)/);
  assert.equal(result.includes("first"), true, "an MCP result keeps its head");
});

test("execution output keeps its tail, where the failure is reported", async () => {
  const guard = new ToolOutputGuard({ sink: { async save() { return record(); } } });
  const text = `${"noise\n".repeat(100_000)}Traceback: boom`;
  const result = await guard.apply("run_python", text);

  assert.match(result, /shows the last /);
  assert.equal(result.endsWith("Traceback: boom"), true);
});

test("a bounded result is trusted up to the hard bound, then re-truncated anyway", async () => {
  const guard = new ToolOutputGuard({ sink: { async save() { return record(); } } });
  const modest = `${"y".repeat(100)}\n`.repeat(1_000);
  assert.equal(await guard.apply("read_file", modest, true), modest, "a self-bounded page is left alone");

  const runaway = `${"y".repeat(100)}\n`.repeat(100_000);
  const result = await guard.apply("read_file", runaway, true);
  assert.match(result, /^\[bounded tool output] read_file/, "a tool that ignores its own bound is still cut");
});

test("a storage failure still yields a bounded result", async () => {
  const guard = new ToolOutputGuard({
    sink: { async save() { throw new Error("disk full"); } },
  });
  const result = await guard.apply("web_fetch", "z\n".repeat(200_000));
  assert.match(result, /could not be stored for re-reading/);
  assert.ok(Buffer.byteLength(result, "utf8") < DEFAULT_TOOL_OUTPUT_MAX_BYTES * 1.1);
});
