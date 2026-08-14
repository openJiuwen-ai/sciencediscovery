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

import type { ComposerReference, SkillDescriptor, WorkbenchSearchResult } from "@science-agent/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ComposerReferenceMenu,
  composerSkillSuggestions,
  filterSearchResults,
  getComposerTrigger,
  GlobalSearchDialog,
  insertComposerReference,
} from "../src/WorkbenchNavigation.js";

const artifactReference: ComposerReference = {
  id: "session-1:plots/result.png",
  kind: "artifact",
  label: "plots/result.png",
  path: "plots/result.png",
  projectId: "project-1",
  sessionId: "session-1",
};

test("detects Composer context triggers and inserts a stable reference token", () => {
  const trigger = getComposerTrigger("Compare @plo");
  assert.deepEqual(trigger, { query: "plo", start: 8, symbol: "@" });
  assert.equal(insertComposerReference("Compare @plo", trigger!, artifactReference), "Compare @[plots/result.png] ");
  assert.deepEqual(getComposerTrigger("Use /dock"), { query: "dock", start: 4, symbol: "/" });
  assert.equal(getComposerTrigger("email@example.org"), undefined);
});

test("`/` only offers the skills the Session can actually run", () => {
  const skills = [
    { description: "Evidence workflow", id: "evidence-brief", name: "evidence-brief" },
    { description: "Docking workflow", id: "docking", name: "docking" },
  ] as SkillDescriptor[];

  // `all` mode mirrors the whole catalog into the Session's effective set.
  assert.deepEqual(
    composerSkillSuggestions(skills, ["evidence-brief", "docking"]).map((item) => item.reference.id),
    ["evidence-brief", "docking"],
  );
  // `selected` mode hides everything outside the whitelist.
  assert.deepEqual(
    composerSkillSuggestions(skills, ["docking"]).map((item) => item.reference.id),
    ["docking"],
  );
  assert.deepEqual(composerSkillSuggestions(skills, []), []);
  // No active Session: nothing to resolve against, so offer the catalog.
  assert.equal(composerSkillSuggestions(skills, undefined).length, 2);
});

test("renders typed Composer suggestions as structured context choices", () => {
  const html = renderToStaticMarkup(createElement(ComposerReferenceMenu, {
    onSelect: () => undefined,
    suggestions: [{ detail: "Result · 42 KB", reference: artifactReference }],
    trigger: { query: "result", start: 0, symbol: "@" },
  }));
  assert.match(html, /aria-label="@ context suggestions"/);
  assert.match(html, /Structured context/);
  assert.match(html, /plots\/result\.png/);
  assert.match(html, /title="plots\/result\.png · Result · 42 KB"/);
});

test("global search filters and renders project, Session, and artifact navigation", () => {
  const results: WorkbenchSearchResult[] = [
    { detail: "Project", id: "project:1", kind: "project", label: "Proteomics", projectId: "project-1" },
    { detail: "Proteomics", id: "session:1", kind: "session", label: "Differential analysis", projectId: "project-1", sessionId: "session-1" },
    { detail: "Proteomics / Differential analysis", id: "artifact:1", kind: "artifact", label: "plots/volcano.png", path: "plots/volcano.png", projectId: "project-1", sessionId: "session-1" },
  ];
  assert.deepEqual(filterSearchResults(results, "volcano").map((item) => item.id), ["artifact:1"]);

  const html = renderToStaticMarkup(createElement(GlobalSearchDialog, {
    onClose: () => undefined,
    onQueryChange: () => undefined,
    onSelect: () => undefined,
    query: "",
    results,
  }));
  assert.match(html, /Search projects, sessions, and artifacts/);
  assert.match(html, /Proteomics/);
  assert.match(html, /Differential analysis/);
  assert.match(html, /plots\/volcano\.png/);
  assert.match(html, /title="plots\/volcano\.png · Proteomics \/ Differential analysis"/);
});
