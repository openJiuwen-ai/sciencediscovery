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

import { createTest } from "../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import {
  composeBody,
  contributorHandlesFrom,
  formatContributors,
  formatSummary,
  newContributorCount,
  previousTagFrom,
  pullRequestNumbers,
  rankContributors,
} from "./release-notes.mjs";

// A trimmed copy of what generate-notes returned for this repository, kept
// shaped like the real thing — bot authors, a non-ASCII title, and the blank
// line before Full Changelog all appear in its output.
const generated = `## What's Changed
* fix(api): 消除 reviewer audit 测试套件竞态 by @openjiuwen-sync-bot[bot] in https://github.com/o/r/pull/6
* ci: fix two jobs by @openjiuwen-release-bot[bot] in https://github.com/o/r/pull/112
* test(e2e): establish the empty instance by @zhaozhaozz in https://github.com/o/r/pull/113

## New Contributors
* @zhaozhaozz made their first contribution in https://github.com/o/r/pull/113

**Full Changelog**: https://github.com/o/r/compare/0.2.0...0.3.0`;

test("pull request numbers come from What's Changed, deduplicated and ordered", () => {
  assert.deepEqual(pullRequestNumbers(generated), [6, 112, 113]);
  // The same pull request appearing twice inside the section is one entry.
  assert.deepEqual(pullRequestNumbers("## What's Changed\n* a in /pull/9\n* b in /pull/9\n* c in /pull/2"), [2, 9]);
  // An issue link is not a pull request link.
  assert.deepEqual(pullRequestNumbers("## What's Changed\n* see /issues/7"), []);
  assert.deepEqual(pullRequestNumbers("**Full Changelog**: compare/a...b"), []);
});

test("a pull request excluded from the list is not counted as being in it", () => {
  // What .github/release.yml's `exclude` produces: release:skip drops the
  // bullet from What's Changed — here the whole section with it — while
  // GitHub still credits the same pull request under New Contributors.
  // Counting across the body would claim one pull request the note does not
  // show, which is exactly the claim a reader can check and find false.
  const excluded = `<!-- Release notes generated using configuration in .github/release.yml at main -->


## New Contributors
* @zhaozhaozz made their first contribution in https://github.com/o/r/pull/3

**Full Changelog**: https://github.com/o/r/compare/a...b`;
  assert.deepEqual(pullRequestNumbers(excluded), []);
  assert.equal(newContributorCount(excluded), 1);
});

test("category headings inside What's Changed do not end the section", () => {
  // .github/release.yml renders its categories as `###` under the one `##`
  // heading, so a section scan that stops at any heading would count only the
  // first category.
  const categorised = `## What's Changed
### 💥 Breaking Changes / 不兼容变更
* a by @x in https://github.com/o/r/pull/1

### 🐛 Bug Fixes / 问题修复
* b by @y in https://github.com/o/r/pull/2

## New Contributors
* @y made their first contribution in https://github.com/o/r/pull/2`;
  assert.deepEqual(pullRequestNumbers(categorised), [1, 2]);
});

test("new contributors are counted only within their own section", () => {
  assert.equal(newContributorCount(generated), 1);
  // No section at all is zero rather than a crash: nobody's first
  // contribution landing in a range is ordinary.
  assert.equal(newContributorCount("## What's Changed\n* a by @x in /pull/1"), 0);
  const twoSections = `## New Contributors
* @a made their first contribution in /pull/1
* @b made their first contribution in /pull/2

## Something Else
* @c is not a new contributor`;
  assert.equal(newContributorCount(twoSections), 2);
});

test("handles are read from the credit line when there is nothing to compare against", () => {
  assert.deepEqual(contributorHandlesFrom(generated), [
    "openjiuwen-release-bot",
    "openjiuwen-sync-bot",
    "zhaozhaozz",
  ]);
});

test("the previous tag is the newest published release that is not this one", () => {
  const releases = [
    { isDraft: false, publishedAt: "2026-09-02T00:00:00Z", tagName: "0.2.0" },
    { isDraft: false, publishedAt: "2026-08-01T00:00:00Z", tagName: "0.1.1" },
    { isDraft: false, publishedAt: "2026-09-20T00:00:00Z", tagName: "0.3.0" },
  ];
  assert.equal(previousTagFrom(releases, "0.3.0"), "0.2.0");
  // A draft was never announced, so it cannot be the baseline a reader
  // compares against.
  assert.equal(
    previousTagFrom([{ isDraft: true, publishedAt: "2026-09-25T00:00:00Z", tagName: "0.4.0" }, ...releases], "0.4.0"),
    "0.3.0",
  );
  assert.equal(previousTagFrom([], "0.1.0"), undefined);
});

test("the summary states what is true and omits what is not", () => {
  assert.equal(
    formatSummary({ commits: 455, contributors: 11, issues: 3, newContributors: 1, pullRequests: 4 }),
    "**455 commits** · **4 pull requests** · **3 issues closed** · **11 contributors** (1 new)",
  );
  // The range 0.1.1...0.2.0 predates this repository's pull request workflow,
  // so those counts are genuinely zero; printing them would read as a broken
  // generator rather than as history.
  assert.equal(
    formatSummary({ commits: 349, contributors: 11, issues: 0, newContributors: 0, pullRequests: 0 }),
    "**349 commits** · **11 contributors**",
  );
  assert.equal(
    formatSummary({ commits: 1, contributors: 1, issues: 1, newContributors: 0, pullRequests: 1 }),
    "**1 commit** · **1 pull request** · **1 issue closed** · **1 contributor**",
  );
  // A first release has no baseline, so there is no commit count to give.
  assert.equal(formatSummary({ contributors: 2, issues: 0, newContributors: 2, pullRequests: 0 }), "**2 contributors** (2 new)");
});

test("contributors are ranked by how much of the release they wrote", () => {
  const ranked = rankContributors([
    { login: "zhaozhaozz", name: "wang_cheng_zhao" },
    { login: "", name: "Hugaqq" },
    { login: "zhaozhaozz", name: "wang_cheng_zhao" },
    { login: "Birfy", name: "Birfy" },
    { login: "", name: "Hugaqq" },
    { login: "zhaozhaozz", name: "wang_cheng_zhao" },
  ]);
  assert.deepEqual(ranked, [
    { commits: 3, display: "@zhaozhaozz" },
    { commits: 2, display: "Hugaqq" },
    { commits: 1, display: "@Birfy" },
  ]);
  // The same person reached through an account and through a bare commit name
  // is two entries, because nothing here can prove they are one; what must not
  // happen is a commit vanishing because GitHub could not resolve its author.
  assert.deepEqual(rankContributors([{ login: "", name: "" }]), []);
});

test("the contributors section names everyone the count claims", () => {
  const ranked = rankContributors([
    { login: "a", name: "A" },
    { login: "", name: "B" },
  ]);
  assert.equal(formatContributors(ranked), "## Contributors\n\n@a, B");
  assert.equal(ranked.length, 2);
  // A first release with no comparable range has no list, and an empty
  // heading is worse than no heading.
  assert.equal(formatContributors([]), "");
});

test("the body leads with the summary and preserves the generated sections", () => {
  const body = composeBody({
    contributors: "## Contributors\n\n@a",
    generated,
    summary: "**1 commit**",
  });
  assert.match(body, /^\*\*1 commit\*\*\n/);
  assert.ok(body.includes("## What's Changed"));
  assert.ok(body.includes("## New Contributors"));
  // Contributors sits after the compare link, so the roll call follows the
  // release rather than introducing it.
  assert.ok(body.indexOf("compare/0.2.0...0.3.0") < body.indexOf("## Contributors"));
  assert.ok(body.trimEnd().endsWith("@a"));
  // The prompt for a human summary must not render in the published note.
  assert.ok(body.includes("<!-- Highlights:"));
});

test("without a contributors section the body still ends at the compare link", () => {
  const body = composeBody({ generated, summary: "**1 commit**" });
  assert.ok(!body.includes("## Contributors"));
  assert.ok(body.trimEnd().endsWith("compare/0.2.0...0.3.0"));
});
