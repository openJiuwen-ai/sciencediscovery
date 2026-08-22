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

import type { SkillDescriptor } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ApiClient } from "../src/api.js";
import { SkillManager, validateSkillDraft } from "../src/SkillManager.js";

const skill = {
  currentRevision: 1,
  description: "Read-only built-in evidence workflow",
  diagnostics: [],
  hash: "a".repeat(64),
  id: "life-science-evidence-brief",
  name: "life-science-evidence-brief",
  readOnly: true,
  resourceSummary: { bytes: 0, files: 0, kinds: { asset: 0, other: 0, reference: 0, script: 0 } },
  source: "built-in",
  version: "1.1.0",
} satisfies SkillDescriptor;

test("validates portable Agent Skills authoring fields", () => {
  assert.equal(validateSkillDraft({
    allowedTools: "",
    compatibility: "",
    description: "A valid portable skill.",
    instructions: "# Instructions",
    license: "",
    metadata: {},
    name: "portable-skill",
    version: "1.0.0",
  }), undefined);
  assert.match(validateSkillDraft({
    allowedTools: "",
    compatibility: "",
    description: "A valid portable skill.",
    instructions: "# Instructions",
    license: "",
    metadata: {},
    name: "Invalid_name",
    version: "",
  }) ?? "", /lowercase letters/);
});

test("renders an accessible searchable skill catalog with author and import actions", () => {
  const html = renderToStaticMarkup(createElement(SkillManager, {
    client: {} as ApiClient,
    onCatalogChange: () => undefined,
    onError: () => undefined,
    sessionId: "session-1",
    skills: [skill],
  }));

  assert.match(html, /Skill manager/);
  assert.match(html, /aria-label="Search skills"/);
  assert.match(html, /\+ New/);
  assert.match(html, />Import</);
  assert.match(html, /Describe workflow/);
  assert.match(html, /Distill Session/);
  assert.match(html, /Import Git/);
  assert.match(html, /life-science-evidence-brief/);
  assert.match(html, /Built-in/);
  assert.match(html, /aria-label="Skill catalog"/);
});
