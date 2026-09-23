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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import type { ComposerReference, SkillDescriptor, WorkbenchSearchResult } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ComposerCommandChips,
  ComposerReferenceMenu,
  composerInsertionCaret,
  composerReferenceToken,
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
import { LocaleProvider } from "../src/i18n/LocaleProvider.js";

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

test("the caret lands behind an inserted reference, even with text after the trigger", () => {
  const text = "Compare @plo with the baseline";
  const trigger = getComposerTrigger(text, "Compare @plo".length)!;
  const inserted = insertComposerReference(text, trigger, artifactReference, "Compare @plo".length);
  const caret = composerInsertionCaret(trigger, composerReferenceToken(artifactReference));
  assert.equal(inserted.slice(0, caret), "Compare @[plots/result.png] ");
  assert.equal(inserted.slice(caret), " with the baseline");
  const command = getComposerTrigger("/dist")!;
  assert.equal(insertComposerCommand("/dist", command, "/distill-session").slice(0, composerInsertionCaret(command, "/distill-session")), "/distill-session ");
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

test("search results read in the UI's language when the API sends their parts", () => {
  const zh = renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(GlobalSearchDialog, {
    hasMore: false,
    loading: false,
    onClose: () => undefined,
    onQueryChange: () => undefined,
    onSelect: () => undefined,
    query: "growth",
    results: [
      { detail: "Mixed · Archived", id: "session:s1", kind: "session", label: "Untitled session", projectId: "p1", projectName: "Mixed", sessionId: "s1", archived: true },
      { detail: "Mixed / Fit · llm_declared", id: "artifact:a1", kind: "artifact", label: "fit.png", origin: "llm_declared", projectId: "p1", projectName: "Mixed", sessionTitle: "Fit" },
      { detail: "Mixed / Deleted Session · user_upload", id: "artifact:a2", kind: "artifact", label: "growth.csv", origin: "user_upload", projectId: "p1", projectName: "Mixed" },
      { detail: "An older API's line", id: "artifact:a3", kind: "artifact", label: "old.csv", projectId: "p1" },
    ],
    total: 4,
  })));
  assert.match(zh, /未命名会话/);
  assert.match(zh, /Mixed · 已归档/);
  assert.match(zh, /Mixed \/ Fit · 智能体登记/);
  assert.match(zh, /Mixed \/ 已删除会话 · 用户上传/);
  assert.match(zh, /An older API&#x27;s line|An older API's line/);
  assert.match(zh, /<em>会话<\/em>/);
  assert.match(zh, /<em>产物<\/em>/);
  assert.doesNotMatch(zh, /llm_declared|user_upload|<em>session<\/em>/);
});
