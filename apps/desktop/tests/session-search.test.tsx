// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { StubClient, split } from "./api-stub.js";
import { searchWorkbench } from "../src/api/workbench.js";
import { groupSearchResults, isSearchable, searchDetail } from "../src/app/session-search.js";
import type { WorkbenchSearchResult } from "../src/api/types.js";

function hit(kind: WorkbenchSearchResult["kind"], label: string, over: Partial<WorkbenchSearchResult> = {}) {
  return { detail: "", id: `${kind}-1`, kind, label, projectId: "p1", ...over } as WorkbenchSearchResult;
}

test("the search route is asked with the query and a page window", async () => {
  const stub = new StubClient().reply({ hasMore: false, limit: 20, offset: 0, results: [], total: 0 });
  await searchWorkbench(stub.asClient(), "晶体 结构");
  const call = split(stub.calls[0]!);
  assert.equal(call.pathname, "/api/search");
  assert.equal(call.query.get("q"), "晶体 结构");
  assert.equal(call.query.get("limit"), "20");
  assert.equal(call.query.get("offset"), "0");
});

test("results are grouped in a fixed order and empty groups are dropped", () => {
  const groups = groupSearchResults([
    hit("artifact", "figure.png"),
    hit("session", "本周实验"),
    hit("project", "材料"),
  ]);
  assert.deepEqual(groups.map((group) => group.kind), ["project", "session", "artifact"]);

  const onlySessions = groupSearchResults([hit("session", "a"), hit("session", "b")]);
  assert.deepEqual(onlySessions.map((group) => group.kind), ["session"]);
  assert.deepEqual(groupSearchResults([]), []);
});

test("a result's detail names its Project and, for an artifact, its Session", () => {
  assert.equal(searchDetail(hit("session", "a", { projectName: "材料" })), "材料");
  assert.equal(searchDetail(hit("artifact", "f", { projectName: "材料", sessionTitle: "本周实验" })), "材料 · 本周实验");
  assert.equal(searchDetail(hit("session", "a")), "", "absent parts print nothing rather than undefined");
});

test("an empty query is not sent, and an archived result is marked", () => {
  assert.equal(isSearchable("  "), false);
  assert.equal(isSearchable("晶"), true);
  assert.equal(hit("session", "a", { archived: true }).archived, true);
});
