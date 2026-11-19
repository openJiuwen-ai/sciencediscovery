// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import {
  ownerRunId,
  turnArtifacts,
  turnArtifactsByRun,
  turnLineage,
  type TurnLineage,
} from "../src/app/turn-artifacts.js";

type Kind = Parameters<typeof turnArtifacts>[0][number]["artifact"]["kind"];

let seq = 0;
function output(over: {
  artifactId?: string;
  kind?: Kind;
  name?: string;
  /** The version's `turnId`: the SessionRun, or a subagent id. */
  turnId?: string;
  /** Distinct from `turnId` on every real version. */
  executionRunIds?: string[];
  version?: number;
  createdAt?: string;
  baseVersionId?: string;
} = {}) {
  seq += 1;
  const artifactId = over.artifactId ?? `artifact-${seq}`;
  const turnId = over.turnId ?? "run-1";
  return {
    artifact: {
      id: artifactId,
      kind: over.kind ?? "report",
      name: over.name ?? `${artifactId}.md`,
      createdAt: "2026-11-19T10:00:00.000Z",
      createdInSessionId: "s1",
      createdInSessionTitle: "Session",
      currentVersion: over.version ?? 1,
      logicalName: artifactId,
      origin: "llm_declared",
      projectId: "p1",
      sessionId: "s1",
    },
    version: {
      id: `${artifactId}-v${over.version ?? 1}`,
      artifactId,
      createdAt: over.createdAt ?? "2026-11-19T10:00:00.000Z",
      // The execution row that wrote the bytes — never the run id, which is
      // what makes a join on this field match nothing in the real catalog.
      executionRunIds: over.executionRunIds ?? [`exec-${artifactId}-${over.version ?? 1}`],
      inputArtifactVersionIds: [],
      mediaType: "text/markdown",
      projectId: "p1",
      sessionId: "s1",
      turnId,
      version: over.version ?? 1,
      ...(over.baseVersionId ? { baseVersionId: over.baseVersionId } : {}),
    },
  } as never;
}

/** The open Session's runs, as the transcript draws them. */
const RUNS: TurnLineage = turnLineage(["run-1", "run-2"], []);

test("a version joins its run by turnId, not by executionRunIds", () => {
  // The shape the backend really writes: turnId names the SessionRun,
  // executionRunIds names the execution that produced the bytes.
  const mine = output({ artifactId: "mine", turnId: "run-1", executionRunIds: ["exec-1"] });
  const theirs = output({ artifactId: "theirs", turnId: "run-2", executionRunIds: ["exec-2"] });

  const result = turnArtifacts([mine, theirs] as never, "run-1", RUNS);
  assert.deepEqual(result.visible.map((row) => row.artifact.id), ["mine"]);
});

test("a version whose executionRunIds happen to name a run is not attached by them", () => {
  // The bug the first cut shipped: executionRunIds holding a run id made the
  // fixtures pass while real Sessions stayed empty. turnId is what decides.
  const other = output({ artifactId: "other-turn", turnId: "run-2", executionRunIds: ["run-1"] });
  const result = turnArtifacts([other] as never, "run-1", RUNS);
  assert.deepEqual(result.visible, []);
});

test("a version with no turn id is never attached", () => {
  const uploaded = output({ artifactId: "upload", turnId: undefined as unknown as string });
  delete (uploaded as { version: { turnId?: string } }).version.turnId;
  assert.deepEqual(turnArtifacts([uploaded] as never, "run-1", RUNS), { visible: [], hidden: 0 });
});

test("a turn id the transcript does not know is left out rather than guessed at", () => {
  const stranger = output({ artifactId: "stranger", turnId: "not-a-run-here" });
  assert.deepEqual(turnArtifacts([stranger] as never, "run-1", RUNS), { visible: [], hidden: 0 });
});

test("one row per artifact, at the highest ordinal", () => {
  const older = output({ artifactId: "report", version: 1 });
  const newer = output({ artifactId: "report", version: 3 });

  const result = turnArtifacts([older, newer] as never, "run-1", RUNS);
  assert.equal(result.visible.length, 1);
  assert.equal(result.visible[0]!.version.version, 3);
});

test("a later turn's version of the same file does not take this turn's row", () => {
  // The file was amended by run-2; run-1's row still shows what run-1 wrote.
  const mine = output({ artifactId: "report", turnId: "run-1", version: 2 });
  const later = output({ artifactId: "report", turnId: "run-2", version: 5 });

  const first = turnArtifacts([mine, later] as never, "run-1", RUNS);
  assert.equal(first.visible.length, 1);
  assert.equal(first.visible[0]!.version.version, 2);
  const second = turnArtifacts([mine, later] as never, "run-2", RUNS);
  assert.equal(second.visible[0]!.version.version, 5);
});

test("the ordinal wins over a later timestamp, which import reorders", () => {
  // An imported Session keeps the package's ordinals, but every row can carry the
  // import time as createdAt — the two disagree, and the file's own lineage wins.
  const ordinal = output({ artifactId: "report", version: 3, createdAt: "2026-11-01T00:00:00.000Z" });
  const imported = output({ artifactId: "report", version: 1, createdAt: "2026-11-19T10:00:00.000Z" });

  const result = turnArtifacts([ordinal, imported] as never, "run-1", RUNS);
  assert.equal(result.visible[0]!.version.version, 3);
});

test("rows are ordered by kind, then newest first, and mark an update", () => {
  const figure = output({ artifactId: "a-figure", kind: "figure", version: 1 });
  const report = output({ artifactId: "b-report", kind: "report", version: 2 });
  const dataset = output({ artifactId: "c-dataset", kind: "dataset", version: 1, baseVersionId: "c-v0" });

  const result = turnArtifacts([figure, dataset, report] as never, "run-1", RUNS);
  assert.deepEqual(result.visible.map((row) => row.artifact.id), ["b-report", "a-figure", "c-dataset"]);
  assert.equal(result.visible[2]!.updated, true);
  assert.equal(result.visible[0]!.updated, false);
});

test("intermediate kinds are folded behind the important ones", () => {
  const report = output({ artifactId: "report", kind: "report" });
  const dump = output({ artifactId: "dump", kind: "json" });
  const log = output({ artifactId: "log", kind: "other" });

  const result = turnArtifacts([dump, log, report] as never, "run-1", RUNS);
  assert.deepEqual(result.visible.map((row) => row.artifact.id), ["report"]);
  assert.equal(result.hidden, 2);
});

test("a turn that only produced intermediate kinds still shows them", () => {
  const dump = output({ artifactId: "dump", kind: "json" });
  const log = output({ artifactId: "log", kind: "other" });

  const result = turnArtifacts([dump, log] as never, "run-1", RUNS);
  assert.equal(result.visible.length, 2);
  assert.equal(result.hidden, 0);
});

test("the strip shows five rows and counts the rest", () => {
  const rows = Array.from({ length: 8 }, (_, index) =>
    output({ artifactId: `artifact-${index}`, kind: "dataset", version: index + 1 }));

  const result = turnArtifacts(rows as never, "run-1", RUNS);
  assert.equal(result.visible.length, 5);
  assert.equal(result.hidden, 3);
  // Newest first within one kind.
  assert.deepEqual(result.visible.map((row) => row.version.version), [8, 7, 6, 5, 4]);
});

test("files of one kind and one version are listed by name, not by id", () => {
  // Seven reports written in one turn: same kind, same ordinal, same time. Only
  // the name can order them, and a reader expects 1 before 7.
  const rows = [7, 3, 1, 5, 2, 6, 4].map((index) =>
    output({ artifactId: `report-${index}`, kind: "report", name: `report-${index}.md`, version: 1 }));

  const result = turnArtifacts(rows as never, "run-1", RUNS);
  assert.deepEqual(
    result.visible.map((row) => row.artifact.name),
    ["report-1.md", "report-2.md", "report-3.md", "report-4.md", "report-5.md"],
  );
  assert.equal(result.hidden, 2);
});

test("a child's version climbs parentTurnId to the run that delegated it", () => {
  // Four of eleven versions in a local catalog were subagent-produced: their
  // turnId is the child, whose parentTurnId is the run. Leaving them out would
  // silently drop what the run wrote.
  const lineage = turnLineage(["run-1"], [
    { id: "sub-1", parentTurnId: "run-1" },
  ] as never);
  const child = output({ artifactId: "from-child", turnId: "sub-1" });
  const main = output({ artifactId: "from-main", turnId: "run-1" });

  const result = turnArtifacts([child, main] as never, "run-1", lineage);
  assert.deepEqual(result.visible.map((row) => row.artifact.id), ["from-child", "from-main"]);
});

test("a child of a child still resolves, and a cycle resolves to nothing", () => {
  const nested = turnLineage(["run-1"], [
    { id: "sub-outer", parentTurnId: "run-1" },
    { id: "sub-inner", parentTurnId: "sub-outer" },
  ] as never);
  const deep = output({ artifactId: "deep", turnId: "sub-inner" });
  assert.equal(ownerRunId((deep as { version: never }).version, nested), "run-1");

  // A cycle has no run above it; the walk must stop rather than spin.
  const cyclic = turnLineage(["run-1"], [
    { id: "a", parentTurnId: "b" },
    { id: "b", parentTurnId: "a" },
  ] as never);
  const orphan = output({ artifactId: "orphan", turnId: "a" });
  assert.equal(ownerRunId((orphan as { version: never }).version, cyclic), undefined);
});

test("the by-run map buckets each version under its own run", () => {
  const first = output({ artifactId: "a-report", turnId: "run-1" });
  const second = output({ artifactId: "b-figure", turnId: "run-2" });
  const upload = output({ artifactId: "c-upload" });
  delete (upload as { version: { turnId?: string } }).version.turnId;

  const byRun = turnArtifactsByRun([first, second, upload] as never, RUNS);
  assert.deepEqual([...byRun.keys()].sort(), ["run-1", "run-2"]);
  assert.deepEqual(byRun.get("run-1")!.visible.map((row) => row.artifact.id), ["a-report"]);
  assert.deepEqual(byRun.get("run-2")!.visible.map((row) => row.artifact.id), ["b-figure"]);
});

test("a run that only wrote intermediate kinds still gets an entry", () => {
  const dump = output({ artifactId: "dump", kind: "json", turnId: "run-2" });
  const byRun = turnArtifactsByRun([dump] as never, RUNS);
  assert.equal(byRun.get("run-2")!.visible.length, 1);
  assert.equal(byRun.get("run-2")!.hidden, 0);
});
