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

import { buildWorkspaceSystemPrompt } from "./workspace-prompt.js";

test("managed environment prompt directs mutations through governed tools", () => {
  const prompt = buildWorkspaceSystemPrompt([], true);
  assert.match(prompt, /environment_list\/environment_create\/environment_delete\/environment_install\/environment_uninstall/);
  assert.match(prompt, /shared base is read-only/i);
  assert.match(prompt, /pip PyPI specs or current-workspace relative wheel files/i);
  assert.match(prompt, /never run conda, mamba, micromamba, or pip directly/i);
  assert.doesNotMatch(prompt, /only the user can create, install, delete/);
});

test("system prompt lists selected skill metadata without injecting instructions", () => {
  const prompt = buildWorkspaceSystemPrompt([{
    content: "Use the selected workflow.",
    description: "A selected workflow for testing progressive skill loading.",
    hash: "b".repeat(64),
    id: "selected-skill",
    readResource: () => ({
      content: "reference",
      hash: "a".repeat(64),
      path: "references/guide.md",
      revision: 4,
      skillId: "selected-skill",
      size: 9,
    }),
    resources: [{ hash: "a".repeat(64), kind: "reference", path: "references/guide.md", size: 9 }],
    revision: 4,
    version: "2.0.0",
  }]);

  assert.match(prompt, /<skill_system>/);
  assert.match(prompt, /<name>selected-skill<\/name>/);
  assert.match(prompt, /A selected workflow for testing progressive skill loading/);
  assert.match(prompt, /<revision>4<\/revision>/);
  assert.match(prompt, /<version>2\.0\.0<\/version>/);
  assert.match(prompt, /read_skill/);
  assert.doesNotMatch(prompt, /Use the selected workflow/);
  assert.doesNotMatch(prompt, /references\/guide\.md \(reference, 9 bytes\)/);
  assert.match(prompt, /never invent a paper or identifier/i);
  assert.match(prompt, /first call artifact_download.*later model turn call paper_extract_pdf/i);
  assert.match(prompt, /Do not issue a PDF extraction in the same turn/i);
  assert.match(prompt, /fails or returns no records, state that evidence gap/i);
  assert.doesNotMatch(prompt, /unselected-skill/);
});

test("system prompt composes a subagent preset with an optional user specialist", () => {
  const prompt = buildWorkspaceSystemPrompt([], false, {
    specialist: { description: "Reviews statistical methods and assumptions.", instructions: "Check statistical assumptions.", name: "Statistics reviewer" },
    subagent: { instructions: "Complete the delegated task autonomously.", name: "general-purpose" },
  });

  assert.match(prompt, /Applied subagent preset general-purpose/);
  assert.match(prompt, /Complete the delegated task autonomously/);
  assert.doesNotMatch(prompt, /SUBAGENT MODE ACTIVE/);
  assert.match(prompt, /Applied user specialist Statistics reviewer/);
  assert.match(prompt, /Reviews statistical methods and assumptions/);
  assert.match(prompt, /Check statistical assumptions/);
});

test("system prompt injects lead subagent orchestration when enabled", () => {
  const prompt = buildWorkspaceSystemPrompt([], false, {
    subagentOrchestration: true,
  });

  assert.match(prompt, /<subagent_system>/);
  assert.match(prompt, /SUBAGENT MODE ACTIVE - DECOMPOSE, DELEGATE, SYNTHESIZE/);
  assert.match(prompt, /Maximum 10 task calls in a single model response/);
  assert.match(prompt, /Maximum 50 task calls for the current user request\/run/);
  assert.match(prompt, /Before launching subagents, count the sub-tasks in your private reasoning/);
  assert.match(prompt, /Do not wrap a single simple action in a subagent/);
  assert.doesNotMatch(prompt, /answer the user directly/);
  assert.doesNotMatch(prompt, /If a selected skill defines a required subagent workflow/);
  assert.doesNotMatch(prompt, /RESULT SYNTHESIS/);
  assert.match(prompt, /<\/subagent_system>/);
});

test("system prompt supports custom lead subagent orchestration limits", () => {
  const prompt = buildWorkspaceSystemPrompt([], false, {
    subagentOrchestration: { maxConcurrent: 2, maxTotal: 8 },
  });

  assert.match(prompt, /Maximum 2 task calls in a single model response/);
  assert.match(prompt, /Maximum 8 task calls for the current user request\/run/);
});

test("system prompt lists enabled built-in specialists by name and description", () => {
  const prompt = buildWorkspaceSystemPrompt([], false, {
    builtinSpecialists: [
      { description: "Searches academic sources across arXiv, PubMed, and CrossRef.", name: "literature-searcher" },
      { description: "Extracts structured evidence from source texts.", name: "evidence-extractor" },
    ],
  });

  assert.match(prompt, /Built-in research specialists available for delegation via the task tool/);
  assert.match(prompt, /- literature-searcher: Searches academic sources across arXiv, PubMed, and CrossRef\./);
  assert.match(prompt, /- evidence-extractor: Extracts structured evidence from source texts\./);
  // The built-in roster is a name/description listing only; instructions are not inlined here.
  assert.doesNotMatch(prompt, /You are literature-searcher/);
});

test("system prompt omits the built-in specialists section when none are enabled", () => {
  const prompt = buildWorkspaceSystemPrompt([], false, {
    builtinSpecialists: [],
  });

  assert.doesNotMatch(prompt, /Built-in research specialists available for delegation/);
});

test("memory graph prompt lays out the citation-chain flow in order", () => {
  const prompt = buildWorkspaceSystemPrompt([], false, { memoryGraphEnabled: true });
  // The steps appear in the query_graph -> declare_evidence -> list_artifacts
  // -> declare_claim -> declare_artifact(output) -> chat-message order.
  const queryIdx = prompt.indexOf("query_graph — optional");
  const evidenceIdx = prompt.indexOf("declare_evidence —");
  const listIdx = prompt.indexOf("list_artifacts —");
  const claimIdx = prompt.indexOf("declare_claim —");
  const artifactIdx = prompt.indexOf("declare_artifact(output) —");
  const chatIdx = prompt.indexOf("Put the same aliases in the final chat message");
  assert.ok(queryIdx > -1 && evidenceIdx > queryIdx, "query_graph precedes declare_evidence");
  assert.ok(listIdx > evidenceIdx, "declare_evidence precedes list_artifacts");
  assert.ok(claimIdx > listIdx, "list_artifacts precedes declare_claim");
  assert.ok(artifactIdx > claimIdx, "declare_claim precedes declare_artifact(output)");
  assert.ok(chatIdx > artifactIdx, "declare_artifact(output) precedes the chat-message step");
  // declare_claim cites ids from the earlier steps (evidence_id, list step)
  // and requires the alias be passed in its cites_*_aliases params.
  assert.match(prompt, /cites_evidence_aliases as/i);
  assert.match(prompt, /cites_artifact_aliases as/i);
  assert.match(prompt, /from step 3/i);
  assert.match(prompt, /Every \[evidenceN\]\/\[artifactN\] token in the body MUST have a matching entry in the same declare_claim's alias params/i);
  // Alias format is fixed to evidence+number / artifact+number, no other formats.
  assert.match(prompt, /evidence\+number for evidence \(e\.g\. \[evidence1\]\)/i);
  assert.match(prompt, /artifact\+number for artifacts \(e\.g\. \[artifact1\]\)/i);
  assert.match(prompt, /no other formats/i);
  // Silence rule: do not narrate declare/query steps to the user.
  assert.match(prompt, /Do NOT narrate these steps to the user/i);
  assert.match(prompt, /never say .*I will declare these files as artifacts/i);
});

test("memory graph prompt is absent when the feature is disabled", () => {
  const prompt = buildWorkspaceSystemPrompt([], false, { memoryGraphEnabled: false });
  assert.doesNotMatch(prompt, /Citation chain/i);
});
