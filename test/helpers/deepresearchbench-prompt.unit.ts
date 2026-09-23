// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createTest } from "../support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { researchPrompt } from "./deepresearchbench.ts";

test("optional cost profile limits total children without changing the benchmark question", () => {
  const prompt = researchPrompt("Original question", "report.md", "2");
  assert.match(prompt, /at most 2 subagents TOTAL/);
  assert.match(prompt, /Failed or cancelled children also count/);
  assert.match(prompt, /<task>\nOriginal question\n<\/task>/);
  assert.match(prompt, /declared Markdown Artifact named report.md/);
  for (const invalid of ["", "-1", "1.5", "NaN"]) {
    assert.throws(() => researchPrompt("q", "r.md", invalid), /non-negative integer/);
  }
});
