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

import { createTest } from "../../../test/support/tagged/compat.mjs";
import { skillChoices, skillDraft, skillMark, slashQuery } from "../src/app/slash.js";
import type { SkillDescriptor } from "../src/api/types.js";

const { describe, it } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

const SKILLS = [
  { description: "", id: "skill-creator", name: "Skill Creator" },
  { description: "", id: "distill-session", name: "Distill Session" },
  { description: "", id: "sepsis-endotyping", name: "Sepsis Endotyping" },
] as SkillDescriptor[];

describe("a draft is asking for a skill only while it is one slash command", () => {
  it("reads the filter from the slash", () => {
    assert.equal(slashQuery("/"), "");
    assert.equal(slashQuery("/sep"), "sep");
  });

  it("ends at the space that starts the request", () => {
    assert.equal(slashQuery("/sepsis-endotyping cluster the samples"), undefined);
    assert.equal(slashQuery(""), undefined);
    assert.equal(slashQuery("see /tmp/file"), undefined);
    // A slash in the middle of a line is a path or a fraction, not a pick.
    assert.equal(slashQuery("read\n/tmp"), undefined);
  });
});

describe("the palette offers the skills the filter names", () => {
  it("lists them all for a bare slash", () => {
    assert.deepEqual(skillChoices(SKILLS, "").map((skill) => skill.id), [
      "skill-creator",
      "distill-session",
      "sepsis-endotyping",
    ]);
  });

  it("matches the name as well as the id, ignoring case", () => {
    assert.deepEqual(skillChoices(SKILLS, "DISTILL").map((skill) => skill.id), ["distill-session"]);
    assert.deepEqual(skillChoices(SKILLS, "creator").map((skill) => skill.id), ["skill-creator"]);
    assert.deepEqual(skillChoices(SKILLS, "-"), SKILLS);
  });

  it("shows a bounded list rather than a wall of rows", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ id: `s${index}`, name: `S${index}` })) as SkillDescriptor[];
    assert.equal(skillChoices(many, "").length, 8);
  });
});

describe("picking a skill writes the command, not the description", () => {
  it("leaves the caret ready for the request", () => {
    assert.equal(skillDraft(SKILLS[0] as SkillDescriptor), "/skill-creator ");
  });
});

describe("a skill's mark is its initial, as 设置 › 技能 draws it", () => {
  it("takes the first letter, upper-cased", () => {
    assert.equal(skillMark({ name: "antibody-design" }), "A");
    assert.equal(skillMark({ name: "RNA-seq reviewer" }), "R");
  });
});
