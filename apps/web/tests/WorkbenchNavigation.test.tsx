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

import type { ComposerReference, SkillDescriptor, WorkbenchSearchResult } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ComposerCommandChips,
  ComposerReferenceMenu,
  composerSkillSuggestions,
  GLOBAL_SEARCH_DEBOUNCE_MS,
  getComposerTrigger,
  GlobalSearchDialog,
  insertComposerCommand,
  insertComposerReference,
  removeSkillAuthoringCommand,
  selectedSkillAuthoringCommands,
  SKILL_AUTHORING_COMMANDS,
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

test("inserts Skill authoring commands without attaching a catalog reference", () => {
  const trigger = getComposerTrigger("/dist");
  assert.equal(insertComposerCommand("/dist", trigger!, "/distill-session"), "/distill-session ");
  assert.deepEqual(SKILL_AUTHORING_COMMANDS.map((item) => item.command), ["/skill-creator", "/distill-session"]);
  const html = renderToStaticMarkup(createElement(ComposerReferenceMenu, {
    onSelect: () => undefined,
    suggestions: SKILL_AUTHORING_COMMANDS,
    trigger: { query: "skill", start: 0, symbol: "/" },
  }));
  assert.match(html, /skill-creator/);
  assert.match(html, /reviewable Skill package/);
  assert.match(html, /composer-command-suggestion/);
  assert.match(html, />Authoring</);
});

test("renders selected Skill authoring commands as removable high-emphasis chips", () => {
  const message = "/code-engineer /skill-creator Build a presentation review workflow";
  assert.deepEqual(
    selectedSkillAuthoringCommands(message).map((item) => item.command),
    ["/skill-creator"],
  );
  assert.equal(
    removeSkillAuthoringCommand(message, "/skill-creator"),
    "/code-engineer Build a presentation review workflow",
  );
  assert.deepEqual(selectedSkillAuthoringCommands("Explain /skill-creator-like syntax"), []);

  const html = renderToStaticMarkup(createElement(ComposerCommandChips, {
    commands: selectedSkillAuthoringCommands(message),
    onRemove: () => undefined,
  }));
  assert.match(html, /composer-command-chips/);
  assert.match(html, /Selected Skill authoring commands/);
  assert.match(html, /Remove \/skill-creator from the prompt/);
  assert.match(html, /Skill authoring/);
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

test("global search renders limited mixed-catalog pages and authoritative server matches", () => {
  const results: WorkbenchSearchResult[] = Array.from({ length: 301 }, (_, index) => {
    const kind = (["project", "session", "artifact"] as const)[index % 3]!;
    return {
      detail: `Mixed catalog ${kind}`,
      id: `${kind}:${index}`,
      kind,
      label: index === 300 ? "target-after-250.csv" : `${kind}-${index}`,
      ...(kind === "artifact" ? { path: `artifact-${index}.csv` } : {}),
      projectId: `project-${index}`,
      ...(kind === "project" ? {} : { sessionId: `session-${index}` }),
    };
  });
  const html = renderToStaticMarkup(createElement(GlobalSearchDialog, {
    hasMore: true,
    loading: false,
    onClose: () => undefined,
    onQueryChange: () => undefined,
    onSelect: () => undefined,
    query: "",
    results: results.slice(0, 250),
    total: 301,
  }));
  assert.match(html, /Search projects, sessions, and artifacts/);
  assert.match(html, /project-0/);
  assert.match(html, /session-1/);
  assert.match(html, /artifact-2/);
  assert.doesNotMatch(html, /project-81/);
  assert.match(html, /Showing 80 of 301 results/);

  const targetedHtml = renderToStaticMarkup(createElement(GlobalSearchDialog, {
    hasMore: false,
    loading: false,
    onClose: () => undefined,
    onQueryChange: () => undefined,
    onSelect: () => undefined,
    query: "server-authoritative-query",
    results: [results[300]!],
    total: 1,
  }));
  assert.match(targetedHtml, /target-after-250\.csv/);
  assert.ok(GLOBAL_SEARCH_DEBOUNCE_MS >= 200 && GLOBAL_SEARCH_DEBOUNCE_MS <= 500);
});
