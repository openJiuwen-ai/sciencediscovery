// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { StubClient, split } from "./api-stub.js";
import { searchWorkbench } from "../src/api/workbench.js";
import {
  artifactHitPlan, bareSearchId, flatResults, groupSearchResults, isSearchable, moveHit, pendingArtifactHit,
  searchDetail, withoutArchivedHits,
} from "../src/app/session-search.js";
import type { WorkbenchSearchResponse, SessionArtifactOutput, WorkbenchSearchResult } from "../src/api/types.js";

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

test("the page drops an archived Session's hits and its artifacts, and counts what it dropped", () => {
  // The route answers archived hits — the flag is there for a client that marks
  // them — and the page keeps the rule that they are not searchable. What it
  // drops is what `total` over-counts, so the count has to lose them first.
  const answer = {
    hasMore: false,
    limit: 20,
    offset: 0,
    results: [
      hit("session", "在跑的", { id: "session:live", sessionId: "live" }),
      hit("session", "已归档", { id: "session:gone", sessionId: "gone" }),
      hit("artifact", "归档图", { id: "artifact:gone", sessionId: "gone" }),
    ],
    total: 3,
  } as WorkbenchSearchResponse;

  const kept = withoutArchivedHits(answer, new Set(["gone"]));
  assert.deepEqual(kept.answer.results.map((result) => result.label), ["在跑的"]);
  assert.equal(kept.dropped, 2);
  assert.equal(kept.answer.total, 1, "the count no longer includes what will never be drawn");

  // A hit with no Session — a Project — is kept whatever the archived set holds.
  const project = withoutArchivedHits(
    { ...answer, results: [hit("project", "材料")], total: 1 } as WorkbenchSearchResponse,
    new Set(["gone"]),
  );
  assert.equal(project.dropped, 0);
  assert.equal(project.answer.results.length, 1);

  // And an empty archived set is a pass-through, not a copy.
  const untouched = withoutArchivedHits(answer, new Set());
  assert.equal(untouched.answer, answer);
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

test("a hit's id carries its kind, and the actions take the bare one", () => {
  // `GET /api/search` composes ids as `<kind>:<id>` so two hits with the same
  // uuid cannot collide. Everything that acts on a hit — selectProject,
  // pendingArtifactHit — compares against the bare id the rest of the API uses.
  assert.equal(bareSearchId("project:7d1f"), "7d1f");
  assert.equal(bareSearchId("session:7d1f"), "7d1f");
  assert.equal(bareSearchId("artifact:7d1f"), "7d1f");
  assert.equal(bareSearchId("7d1f"), "7d1f", "a bare id is already bare");
  assert.equal(bareSearchId("artifact:"), "", "an empty tail stays empty rather than becoming the kind");

  // The failure this guards: the route's `artifact:<id>` used as the pending id
  // never matches the listed output, so the click opened nothing.
  const listed = [output("7d1f", { createdIn: "s1" })];
  const pending = { artifactId: bareSearchId("artifact:7d1f"), sessionId: "s1" };
  assert.equal(pendingArtifactHit(listed, pending)?.artifact.id, "7d1f",
    "the prefixed hit opens the document the panel lists under its bare id");
  assert.equal(pendingArtifactHit(listed, { artifactId: "artifact:7d1f", sessionId: "s1" }), undefined,
    "and passing the prefixed id through unchanged would match nothing");
});

test("an artifact hit for the Session already open opens at once, and for any other waits", () => {
  const listed = [output("7d1f", { createdIn: "s1" })];

  // The case that used to do nothing: the hit names the open Session, so
  // `openSession` is a no-op and nothing would ever re-run the wait.
  const same = artifactHitPlan(listed, { id: "artifact:7d1f", sessionId: "s1" }, "s1");
  assert.ok("open" in same, "a document the panel already lists must open immediately");
  assert.equal(same.open.artifact.id, "7d1f", "and the prefixed hit still resolves to the bare id");

  // Same Session, but its list has not arrived yet: hold it rather than drop it.
  const notYet = artifactHitPlan([], { id: "artifact:7d1f", sessionId: "s1" }, "s1");
  assert.ok("pending" in notYet, "an unlisted document for the open Session is still a wait");
  assert.deepEqual(notYet.pending, { artifactId: "7d1f", sessionId: "s1" });

  // Another Session: always a wait, because its outputs are not in hand.
  const other = artifactHitPlan(listed, { id: "artifact:7d1f", sessionId: "s2" }, "s1");
  assert.ok("pending" in other, "another Session's document cannot open before that Session is read");
  assert.deepEqual(other.pending, { artifactId: "7d1f", sessionId: "s2" });

  // Nothing open at all: same answer.
  const none = artifactHitPlan([], { id: "artifact:7d1f", sessionId: "s1" }, undefined);
  assert.ok("pending" in none);
});
