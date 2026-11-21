// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { StubClient, split } from "./api-stub.js";
import { searchWorkbench } from "../src/api/workbench.js";
import {
  flatResults, groupSearchResults, isSearchable, moveHit, pendingArtifactHit, searchDetail,
} from "../src/app/session-search.js";
import type { SessionArtifactOutput, WorkbenchSearchResult } from "../src/api/types.js";

function hit(kind: WorkbenchSearchResult["kind"], label: string, over: Partial<WorkbenchSearchResult> = {}) {
  return { detail: "", id: `${kind}-1`, kind, label, projectId: "p1", ...over } as WorkbenchSearchResult;
}

function output(artifactId: string, over: { createdIn?: string; versionSession?: string } = {}) {
  return {
    artifact: { createdInSessionId: over.createdIn ?? "", id: artifactId, sessionId: "" },
    version: { id: `${artifactId}-v1`, sessionId: over.versionSession ?? "s1", sourcePath: `${artifactId}.md` },
  } as unknown as SessionArtifactOutput;
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

test("the arrow keys walk the grouped order and wrap", () => {
  const rows = [hit("project", "p"), hit("session", "s"), hit("artifact", "a")];
  assert.deepEqual(flatResults(rows).map((row) => row.kind), ["project", "session", "artifact"],
    "the flat order is the grouped order");

  assert.equal(moveHit(-1, 1, 3), 0, "nothing selected: down takes the first row");
  assert.equal(moveHit(-1, -1, 3), 2, "and up takes the last");
  assert.equal(moveHit(2, 1, 3), 0, "down past the end wraps");
  assert.equal(moveHit(0, -1, 3), 2, "up past the start wraps");
  assert.equal(moveHit(0, 1, 0), -1, "an empty result list has nothing to select");
});

test("an artifact hit opens its document once the panel lists it for that Session", () => {
  const pending = { artifactId: "figure", sessionId: "s1" };
  const listed = [output("report", { createdIn: "s2" }), output("figure", { createdIn: "s1" })];

  assert.equal(pendingArtifactHit(listed, pending)?.artifact.id, "figure", "the listed output is the one to open");
  assert.equal(pendingArtifactHit([output("report", { createdIn: "s2" })], pending), undefined,
    "a list that does not hold the artifact yet opens nothing");
  assert.equal(pendingArtifactHit([output("figure", { createdIn: "s2" })], pending), undefined,
    "an artifact listed only under another Session stays where the panel shows it");
  assert.equal(pendingArtifactHit([output("figure", { createdIn: "s1", versionSession: "s9" })], pending)?.artifact.id,
    "figure", "the creating Session decides, not the version's writer");

  const sameSession = [output("report", { createdIn: "s1" }), output("figure", { createdIn: "s1" })];
  assert.equal(pendingArtifactHit(sameSession, pending)?.artifact.id, "figure",
    "the id decides between two artifacts of one Session");
});

test("output that predates the Session field counts as the open Session's", () => {
  // Every Session field is blank here, so `outputSessionId` answers "" and the
  // panel draws the artifact under the open Session - the hit must still open it.
  const anonymous = output("figure", { versionSession: "" });
  assert.equal(pendingArtifactHit([anonymous], { artifactId: "figure", sessionId: "s1" })?.artifact.id,
    "figure");
  assert.equal(pendingArtifactHit([anonymous], { artifactId: "figure", sessionId: "s2" })?.artifact.id,
    "figure", "and it is nameless, so any Session's hit may claim it");
});
