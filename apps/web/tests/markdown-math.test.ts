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

import { normalizeMathMarkdown } from "../src/markdown-math.js";

test("real inline and display math is left alone", () => {
  for (const text of [
    "insight with $R = C_y^{-1/3}$.",
    "$a$ and $b$",
    "E = $mc^2$, so",
    "$$\n\\int_0^1 x\\,dx\n$$",
    "cost \\$5 is escaped already",
    "no dollars at all",
  ]) assert.equal(normalizeMathMarkdown(text), text);
});

test("dollars that cannot delimit math are escaped", () => {
  assert.equal(
    normalizeMathMarkdown("for i in $(seq 1 120); do echo tick $i; sleep 1; done"),
    "for i in \\$(seq 1 120); do echo tick \\$i; sleep 1; done",
  );
  assert.equal(normalizeMathMarkdown("costs $5 and $10"), "costs \\$5 and \\$10");
  assert.equal(normalizeMathMarkdown("from $10-$20"), "from \\$10-\\$20");
  assert.equal(normalizeMathMarkdown("a $ b $ c"), "a \\$ b \\$ c");
});

test("inline math does not reach across a paragraph break", () => {
  assert.equal(normalizeMathMarkdown("pay $x\n\nand y$ later"), "pay \\$x\n\nand y\\$ later");
  assert.equal(normalizeMathMarkdown("$a +\nb$"), "$a +\nb$");
});

test("code is never touched", () => {
  const fenced = "run:\n```bash\necho $HOME $PATH\n```\nthen $x$";
  assert.equal(normalizeMathMarkdown(fenced), fenced);
  assert.equal(normalizeMathMarkdown("use `echo $i` and pay $5"), "use `echo $i` and pay \\$5");
  const tilde = "~~~\nprice $5\n~~~";
  assert.equal(normalizeMathMarkdown(tilde), tilde);
});

test("LaTeX delimiters become dollar math", () => {
  assert.equal(
    normalizeMathMarkdown("误差随样本量 \\(N\\) 增大按 \\(1/\\sqrt{N}\\) 下降"),
    "误差随样本量 $N$ 增大按 $1/\\sqrt{N}$ 下降",
  );
  assert.equal(normalizeMathMarkdown("where \\( x^2 \\) holds"), "where $x^2$ holds");
  assert.equal(normalizeMathMarkdown("so\n\\[\nE = mc^2\n\\]\nthen"), "so\n$$\nE = mc^2\n$$\nthen");
  assert.equal(normalizeMathMarkdown("inline \\[a+b\\] here"), "inline $$a+b$$ here");
});

test("LaTeX delimiters in code, unclosed or across paragraphs are left alone", () => {
  for (const text of [
    "`\\(x\\)` in code",
    "```\nprint(\"\\(x\\)\")\n```",
    "an escaped \\( paren",
    "open \\(x\n\ny\\) later",
  ]) assert.equal(normalizeMathMarkdown(text), text);
});
