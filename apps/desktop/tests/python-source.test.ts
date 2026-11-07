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

import { highlightPython, splitLines, type SourceToken } from "../src/app/python-source.js";

/** Every token on one line, as `kind:text`, which reads like the page does. */
function kinds(line: readonly SourceToken[]): string[] {
  return line.map((token) => `${token.kind ?? "-"}:${token.text}`);
}

test("a line is coloured by what each word is", () => {
  const [definition] = highlightPython("def area(radius):\n    return radius");
  assert.deepEqual(kinds(definition!), [
    "keyword:def",
    "-: ",
    "definition:area",
    "-:(radius):",
  ]);
});

test("imports keep their keyword and the comment keeps its hash", () => {
  const [line] = highlightPython("import math  # 圆的面积");
  assert.deepEqual(kinds(line!), [
    "keyword:import",
    "-: math  ",
    "comment:# 圆的面积",
  ]);
});

test("a decorator is one token at the start of a line, and a plain @ is not", () => {
  const [at] = highlightPython("@dataclass");
  assert.deepEqual(at, [{ kind: "decorator", text: "@dataclass" }]);

  const [plain] = highlightPython("x = a @ b");
  assert.equal(plain?.some((token) => token.kind === "decorator"), false);
});

test("strings, numbers and the constants Python reserves are coloured", () => {
  const [line] = highlightPython("value = None if count > 10 else 'text'");
  const colours = (line ?? []).filter((token) => token.kind !== undefined);
  assert.deepEqual(
    colours.map((token) => [token.kind, token.text]),
    [
      ["constant", "None"],
      ["keyword", "if"],
      ["number", "10"],
      ["keyword", "else"],
      ["string", "'text'"],
    ],
  );
});

test("a triple-quoted string is split across the lines it spans", () => {
  const lines = highlightPython("doc = \"\"\"one\ntwo\"\"\"\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[1], [{ kind: "string", text: "two\"\"\"" }]);
});

test("closes a triple-quoted string after an escaped backslash", () => {
  // The second backslash is itself escaped, so the delimiter is not escaped.
  const lines = highlightPython("x = \"\"\"a\\\\\"\"\"\ny = 2\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[1]!.every((token) => token.kind !== "string"), `line 2 is code, not string: ${kinds(lines[1]!)}`);
});

test("a file that ends in a newline has no extra blank line after it", () => {
  assert.equal(highlightPython("x = 1\n").length, 1);
  assert.equal(highlightPython("x = 1\n\n").length, 2, "a blank line in the file is still one");
  assert.equal(highlightPython("").length, 1, "an empty file still has a first line");
});

test("windows line endings do not leave a carriage return on each line", () => {
  const lines = highlightPython("a = 1\r\nb = 2\r\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.map((token) => token.text).join(""), "a = 1");
});

test("splitting tokens is the same rule the highlighter uses", () => {
  const lines = splitLines([{ text: "a\nb" }, { kind: "keyword", text: "def" }]);
  assert.deepEqual(lines, [[{ text: "a" }], [{ text: "b" }, { kind: "keyword", text: "def" }]]);
});
