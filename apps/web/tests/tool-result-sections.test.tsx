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

import { formatToolInput, parseToolResultSections } from "../src/timeline/tool-result-sections.js";

test("splits a labeled run_python success into stdout, stderr, and created files", () => {
  const text = "stdout:\n42\nhello\nstderr:\nDeprecationWarning: x\ncreated files: out.csv, plot.png";
  const sections = parseToolResultSections(text, "completed");

  assert.deepEqual(sections.map((section) => section.id), ["stdout", "stderr", "created-files"]);
  assert.equal(sections[0]?.content, "42\nhello");
  assert.equal(sections[0]?.label, "stdout");
  assert.equal(sections[1]?.content, "DeprecationWarning: x");
  assert.equal(sections[2]?.content, "out.csv, plot.png");
  assert.equal(sections[2]?.label, "Created files");
});

test("drops empty placeholder sections emitted by the runner", () => {
  const sections = parseToolResultSections("stdout:\n121932799878\nstderr: (empty)\ncreated files: none", "completed");

  assert.deepEqual(sections.map((section) => section.id), ["stdout"]);
  assert.equal(sections[0]?.content, "121932799878");
});

test("keeps a produced artifacts block as its own section", () => {
  const text = "stdout:\nok\ncreated files: fig.png\nproduced artifacts:\n  - fig.png (artifact_id=a1, kind=figure, v1)";
  const sections = parseToolResultSections(text, "completed");

  assert.deepEqual(sections.map((section) => section.id), ["stdout", "created-files", "produced-artifacts"]);
  assert.match(sections[2]?.content ?? "", /artifact_id=a1/);
});

test("unattributed trailing lines stay with the current section instead of vanishing", () => {
  const text = "stdout:\nok\nenvironment revision: rev-1\nkernel mode: ephemeral";
  const sections = parseToolResultSections(text, "completed");

  assert.deepEqual(sections.map((section) => section.id), ["stdout"]);
  assert.match(sections[0]?.content ?? "", /environment revision: rev-1/);
  assert.match(sections[0]?.content ?? "", /kernel mode: ephemeral/);
});

test("a JSON error envelope stays raw in an Error section on failure", () => {
  const text = "{\"error\": \"ZeroDivisionError: division by zero\"}";
  const sections = parseToolResultSections(text, "failed");

  assert.deepEqual(sections.map((section) => section.id), ["result"]);
  assert.equal(sections[0]?.label, "Error");
  // No decorative pretty-print rewrite — the body is exactly the stream text.
  assert.equal(sections[0]?.content, text);
});

test("unstructured output lands whole in a residual Result section", () => {
  const text = "HTTP 200 OK\n{\"items\": 3}\ntrailing note";
  const sections = parseToolResultSections(text, "completed");

  assert.deepEqual(sections.map((section) => section.id), ["result"]);
  assert.equal(sections[0]?.label, "Result");
  assert.equal(sections[0]?.content, text);
});

test("text preceding the first recognized label is kept as a leading residual section", () => {
  const text = "note from the tool\nstdout:\n42";
  const sections = parseToolResultSections(text, "completed");

  assert.deepEqual(sections.map((section) => section.id), ["result", "stdout"]);
  assert.equal(sections[0]?.content, "note from the tool");
});

test("an output made only of empty placeholders falls back to the raw text", () => {
  const text = "stdout: (empty)\nstderr: (empty)\ncreated files: none";
  const sections = parseToolResultSections(text, "completed");

  assert.deepEqual(sections.map((section) => section.id), ["result"]);
  assert.equal(sections[0]?.content, text);
});

test("a long stdout body is preserved verbatim", () => {
  const body = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
  const sections = parseToolResultSections(`stdout:\n${body}\nstderr: (empty)`, "completed");

  assert.deepEqual(sections.map((section) => section.id), ["stdout"]);
  assert.equal(sections[0]?.content, body);
});

test("formatToolInput shows a single code argument as raw text, not a JSON wrapper", () => {
  const input = formatToolInput({
    args: { code: "print(6 * 7)" },
    id: "tool-1",
    name: "run_python",
    status: "completed",
  });
  assert.equal(input, "print(6 * 7)");
});

test("formatToolInput prefers the primary text field and lists remaining fields compactly", () => {
  const input = formatToolInput({
    args: { code: "print(1)", environmentRevisionId: "rev-1", kernelMode: "persistent" },
    id: "tool-1",
    name: "run_python",
    status: "completed",
  });
  assert.equal(input, "print(1)\nenvironmentRevisionId: rev-1\nkernelMode: persistent");
});

test("formatToolInput uses command for shell-style tools", () => {
  const input = formatToolInput({
    args: { command: "ls -la", timeout: 30 },
    id: "tool-1",
    name: "run_shell",
    status: "completed",
  });
  assert.equal(input, "ls -la\ntimeout: 30");
});

test("formatToolInput falls back to the original input string when there is no primary field", () => {
  const input = formatToolInput({
    args: { limit: 5, offset: 10 },
    id: "tool-1",
    input: "limit=5&offset=10",
    name: "web_search",
    status: "completed",
  });
  assert.equal(input, "limit=5&offset=10");
});

test("formatToolInput compacts multi-field args without pretty indentation", () => {
  const input = formatToolInput({
    args: { limit: 5, offset: 10 },
    id: "tool-1",
    name: "web_search",
    status: "completed",
  });
  assert.equal(input, "{\"limit\":5,\"offset\":10}");
});

test("formatToolInput falls back to the trace input when args are absent", () => {
  const input = formatToolInput({
    id: "tool-1",
    input: "{\n  \"code\": \"print(1)\"\n}",
    name: "run_python",
    status: "completed",
  });
  assert.equal(input, "{\n  \"code\": \"print(1)\"\n}");
});

test("formatToolInput serializes a lone non-string value compactly", () => {
  const input = formatToolInput({
    args: { paths: ["a.csv", "b.csv"] },
    id: "tool-1",
    name: "list_files",
    status: "completed",
  });
  assert.equal(input, "[\"a.csv\",\"b.csv\"]");
});
