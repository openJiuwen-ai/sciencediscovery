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
// The runner compiles JSX with the classic runtime, so React has to be in scope.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { groupsFor } from "../src/app/session-search.js";
import type { WorkbenchSearchResult } from "../src/api/types.js";
import { SearchDialog, type SearchKindFilter } from "../src/views/SearchDialog.js";

const noop = () => {};

function hit(
  kind: "project" | "session" | "artifact",
  label: string,
  updatedAt: string,
  over: Record<string, unknown> = {},
): WorkbenchSearchResult {
  return { detail: "", id: `${kind}:${label}`, kind, label, projectId: "p1", updatedAt, ...over } as WorkbenchSearchResult;
}

function answer(list: WorkbenchSearchResult[], over: Record<string, unknown> = {}) {
  return { hasMore: false, limit: 20, offset: 0, results: list, total: list.length, ...over };
}

function render(
  over: {
    error?: string;
    kind?: SearchKindFilter;
    query?: string;
    results?: ReturnType<typeof answer>;
  } = {},
): string {
  return renderToStaticMarkup(
    <SearchDialog
      error={over.error}
      kind={over.kind ?? "all"}
      onClose={noop}
      onKind={noop}
      onPick={noop}
      onQuery={noop}
      onRetry={noop}
      query={over.query ?? "本周"}
      results={over.results}
    />,
  );
}

test("each group is newest first, and the kinds keep their own order", () => {
  // The route promises no order, so the dialog sorts. Two Sessions out of order
  // and one older than both prove the group's own sort rather than the input's.
  const groups = groupsFor(
    [
      hit("artifact", "figure.png", "2026-01-04T00:00:00.000Z"),
      hit("session", "较早", "2026-01-01T00:00:00.000Z"),
      hit("session", "较新", "2026-01-03T00:00:00.000Z"),
      hit("project", "材料", "2026-01-02T00:00:00.000Z"),
    ],
    "all",
  );
  assert.deepEqual(groups.map((group) => group.kind), ["project", "session", "artifact"]);
  assert.deepEqual(groups[1]?.results.map((result) => result.label), ["较新", "较早"]);
});

test("全部 groups the hits under three headings, and 项目 shows only Projects", () => {
  const all = render({
    results: answer([
      hit("artifact", "figure.png", "2026-01-04T00:00:00.000Z"),
      hit("session", "本周实验", "2026-01-03T00:00:00.000Z"),
      hit("project", "材料", "2026-01-02T00:00:00.000Z"),
    ]),
  });
  const heading = (name: string) => all.indexOf(`search-panel-heading">${name}<`);
  const [project, session, artifact] = [heading("项目"), heading("会话"), heading("产物")];
  assert.ok(project >= 0 && session >= 0 && artifact >= 0, "a group heading is missing");
  assert.ok(project < session && session < artifact, "the headings are not 项目 → 会话 → 产物");
  assert.ok(all.indexOf("材料") < all.indexOf("本周实验"), "the groups are not drawn in that order");

  const onlyProjects = render({
    kind: "project",
    results: answer([
      hit("artifact", "figure.png", "2026-01-04T00:00:00.000Z"),
      hit("project", "材料", "2026-01-02T00:00:00.000Z"),
    ]),
  });
  assert.match(onlyProjects, /材料/u);
  assert.doesNotMatch(onlyProjects, /figure\.png/u, "a kind shows only its own hits");
});

test("every hit carries the mark of its kind", () => {
  const markup = render({
    results: answer([
      hit("project", "材料研究", "2026-10-06T00:00:00.000Z"),
      hit("session", "probe run", "2026-10-05T00:00:00.000Z"),
      hit("artifact", "probe-figure.png", "2026-10-04T00:00:00.000Z", { path: "out/probe-figure.png" }),
    ]),
  });
  assert.equal((markup.match(/class="search-hit-icon"/gu) ?? []).length, 3);
});

test("the footer is the only filter, and it offers 全部 / 项目 / 会话 / 产物", () => {
  const markup = render({ results: answer([hit("project", "材料", "2026-01-02T00:00:00.000Z")]) });
  const foot = markup.slice(markup.indexOf('class="search-panel-foot"'));
  for (const word of ["全部", "项目", "会话", "产物"]) {
    assert.match(foot, new RegExp(`>${word}<`, "u"), `${word} is missing from the footer`);
  }
  const pressed = foot.match(/aria-pressed="true"[^>]*>([^<]+)</u);
  assert.equal(pressed?.[1], "全部", "全部 is the resting kind");
});

test("a failure and an empty answer each say their own thing", () => {
  const failed = render({ error: "boom", results: undefined });
  assert.match(failed, /class="search-panel-note is-error" role="alert">boom/u);
  assert.match(failed, />重试</u);

  const empty = render({ query: "晶", results: answer([]) });
  assert.match(empty, /没有匹配「晶」/u, "the empty state names the query");
});

test("a truncated answer adds nothing: the rows it drew are the answer", () => {
  // The dialog used to count what it held back and tell the reader to keep
  // typing. The owner's call is that the list is the answer and a line
  // explaining how search works is noise around it.
  const results = answer(
    [
      hit("project", "材料", "2026-01-02T00:00:00.000Z"),
      hit("artifact", "figure.png", "2026-01-04T00:00:00.000Z"),
    ],
    { hasMore: true, total: 9 },
  );
  const all = render({ results });
  assert.match(all, /材料/u, "the rows are still drawn");
  assert.doesNotMatch(all, /条结果/u, "全部 counts nothing back to the reader");
  assert.doesNotMatch(all, /继续输入/u, "and never explains how to search");

  const onlyProjects = render({ kind: "project", results });
  assert.match(onlyProjects, /材料/u, "a kind draws its own rows");
  assert.doesNotMatch(onlyProjects, /继续输入/u, "and adds no note either");
});

test("nothing typed yet asks for a query instead of claiming an empty answer", () => {
  const markup = render({ query: "", results: undefined });
  assert.match(markup, /输入以搜索会话、项目和产物。/u, "an untouched field asks for a query");
  assert.doesNotMatch(markup, /没有匹配/u, "an untouched field is not an empty answer");
});
