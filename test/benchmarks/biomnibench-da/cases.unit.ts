// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTest } from "../../support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { analysisPrompt, loadAnalysisPrompt, researchTeamParameters, researchTeamReference, selectedCases, cases, manifest } from "./cases.ts";

test("BiomniBench selection rejects typos and duplicates", () => {
  assert.equal(selectedCases("da-13-3,da-14-1").length, 2);
  assert.equal(selectedCases("da-14-1")[0].id, "da-14-1");
  for (const bad of ["", "da-999-1", "da-13-3,da-13-3"]) assert.throws(() => selectedCases(bad));
});

test("the pinned corpus contains all 50 public tasks and all nested data assets", () => {
  assert.equal(cases.length, 50);
  assert.equal(new Set(cases.map(c => c.id)).size, 50);
  assert.match(manifest.revision, /^[a-f0-9]{40}$/);
  assert.equal(cases.flatMap(c => c.files).filter(f => f.path.startsWith("environment/data/")).length, 463);
  for (const item of cases) {
    for (const path of ["instruction.md", "tests/rubric.txt", "task.toml", "environment/Dockerfile"]) assert.ok(item.files.some(f => f.path === path), `${item.id}/${path}`);
    assert.ok(item.files.every(f => /^[a-f0-9]{40}$/.test(f.oid) && f.bytes >= 0));
  }
});

test("research-team selection is a structured Skill reference", () => {
  assert.deepEqual(researchTeamReference, {
    id: "science-research-team",
    kind: "skill",
    label: "science-research-team",
  });
});

test("delivery appendices preserve upstream instruction without leaking rubric answers", () => {
  for (const item of cases) {
    const instruction = "Original research question and restrictions";
    const prompt = analysisPrompt(item.id, instruction);
    assert.ok(prompt.startsWith(`${instruction}\n\n${researchTeamParameters}\n\n<platform_delivery>`));
    assert.doesNotMatch(prompt, /Make sure to use the science-research-team skill|dispatch multiple sub-agents/);
    assert.match(prompt, /knowledge_domain: disabled/);
    assert.match(prompt, /web_search: disabled/);
    assert.ok(prompt.includes("data/"));
    assert.match(prompt, /trace\.md and answer\.txt/);
    assert.doesNotMatch(prompt, /analysis\.json|analysis\.py|strongest|do not create subagents|Execute reproducible Python/);
    assert.doesNotMatch(prompt, /LEP|rubric_target_scores|Criterion 1/);
  }
});

test("every public task loads its own instruction verbatim and appends Skill parameters once", async () => {
  const root = await mkdtemp(join(tmpdir(), "biomni-prompts-"));
  try {
    for (const item of cases) {
      // Distinct UTF-8 files expose cross-task reuse, lost content and whitespace normalization.
      const instruction = `# ${item.id}\r\nScientific question — 原始题目\r\n  Preserve restrictions and trailing whitespace.  \r\n`;
      await mkdir(join(root, item.id));
      await writeFile(join(root, item.id, "instruction.md"), instruction, "utf8");
      const prompt = await loadAnalysisPrompt(root, item.id);
      assert.equal(prompt.slice(0, instruction.length), instruction, item.id);
      assert.ok(prompt.startsWith(`${instruction}\n\n${researchTeamParameters}\n\n<platform_delivery>`), item.id);
      assert.equal(prompt.split(researchTeamParameters).length - 1, 1, item.id);
    }
    await assert.rejects(loadAnalysisPrompt(root, "../other"), /Unknown public/);
    await rm(join(root, cases[0]!.id, "instruction.md"));
    await assert.rejects(loadAnalysisPrompt(root, cases[0]!.id), { code: "ENOENT" });
    await writeFile(join(root, cases[0]!.id, "instruction.md"), " \n\t");
    await assert.rejects(loadAnalysisPrompt(root, cases[0]!.id), /Empty BiomniBench-DA instruction/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
