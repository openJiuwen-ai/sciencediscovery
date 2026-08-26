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

import type { SkillDescriptor, SkillLibraryUpdateProposal } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { ApiClient } from "../src/api.js";
import { SkillManager, validateSkillDraft } from "../src/SkillManager.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
  assert.match(html, /role="tab"/);
  assert.match(html, />Skills</);
  assert.match(html, />Libraries</);
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

test("renders skill library cards with pinned head version metadata", async () => {
  const client = {
    listSkillLibraries: async () => [{
      createdAt: "2026-01-01T00:00:00.000Z",
      headVersionId: "version-alpha",
      id: "evaluation-skills",
      name: "Evaluation Skills",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }],
    listSkillLibraryVersions: async () => [{
      author: { kind: "user" as const },
      contentHash: "abcdef1234567890",
      createdAt: "2026-01-02T00:00:00.000Z",
      id: "version-alpha",
      libraryId: "evaluation-skills",
      skills: [
        { description: "Alpha", hash: "a".repeat(64), id: "alpha-skill", version: "1.0.0" },
        { description: "Beta", hash: "b".repeat(64), id: "beta-skill", version: "1.0.0" },
      ],
    }],
    listSkillLibraryProposals: async (): Promise<SkillLibraryUpdateProposal[]> => [{
      createdAt: "2026-01-03T00:00:00.000Z",
      id: "proposal-alpha",
      libraryId: "evaluation-skills",
      rationale: "A reusable evaluation workflow was discovered.",
      request: {
        author: { kind: "self-evolution" },
        baseVersionId: "version-alpha",
        dryRun: true,
        operations: [{ package: { files: [{ content: "---\nname: gamma-skill\ndescription: Gamma\n---\n\nUse gamma.\n", path: "SKILL.md" }] }, type: "upsert" }],
      },
      result: {
        conflicts: [],
        diagnostics: [],
        diff: { added: [{ skillId: "gamma-skill" }], deleted: [], modified: [] },
        dryRun: true,
      },
      sourceRefs: [{ id: "run-1", kind: "run" }],
      status: "pending",
      updatedAt: "2026-01-03T00:00:00.000Z",
    }],
    publishSkillLibraryProposal: async () => { throw new Error("not used"); },
    publishSkillLibraryProposals: async () => { throw new Error("not used"); },
    rejectSkillLibraryProposal: async () => { throw new Error("not used"); },
  } as Partial<ApiClient> as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(SkillManager, {
      client,
      initialView: "libraries",
      onCatalogChange: () => undefined,
      onError: () => undefined,
      skills: [skill],
    }));
  });
  await act(async () => undefined);

  const text = JSON.stringify(renderer!.toJSON()).replace(/","/g, "");
  assert.match(text, /Evaluation Skills/);
  assert.match(text, /Head version/);
  assert.match(text, /2 skills/);
  assert.match(text, /abcdef123456/);
  assert.match(text, /Pending proposals/);
  assert.match(text, /gamma-skill/);
  await act(async () => renderer!.unmount());
});
