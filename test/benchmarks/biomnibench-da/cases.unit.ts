// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createTest } from "../../support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { analysisPrompt, researchTeamParameters, researchTeamReference, selectedCases } from "./cases.ts";

test("BiomniBench selection rejects typos and duplicates", () => {
  assert.equal(selectedCases("da-13-3,da-14-1").length, 2);
  assert.equal(selectedCases("da-14-1")[0].id, "da-14-1");
  for (const bad of ["", "da-14-2", "da-13-3,da-13-3"]) assert.throws(() => selectedCases(bad));
});

test("research-team selection is a structured Skill reference", () => {
  assert.deepEqual(researchTeamReference, {
    id: "science-research-team",
    kind: "skill",
    label: "science-research-team",
  });
});

test("parameter and delivery appendices preserve upstream instruction without leaking rubric answers", () => {
  for (const item of selectedCases("da-13-3,da-14-1")) {
    const instruction = `# ${item.id}\r\nOriginal research question and restrictions 科研任务\r\n  `;
    const prompt = analysisPrompt(item.id, instruction, item.file);
    assert.ok(prompt.startsWith(`${instruction}\n\n${researchTeamParameters}\n\n<platform_delivery>\n`));
    assert.equal(prompt.split(researchTeamParameters).length - 1, 1);
    assert.doesNotMatch(prompt, /Make sure to use the science-research-team skill|dispatch multiple sub-agents/);
    assert.match(prompt, /knowledge_domain: disabled/);
    assert.match(prompt, /web_search: disabled/);
    assert.ok(prompt.includes(item.file));
    assert.match(prompt, /trace\.md and answer\.txt/);
    assert.doesNotMatch(prompt, /analysis\.json|analysis\.py|strongest|do not create subagents|Execute reproducible Python/);
    assert.doesNotMatch(prompt, /LEP|rubric_target_scores|Criterion 1/);
  }
});
