// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import { turnArtifacts } from "../src/app/turn-artifacts.js";

type Kind = Parameters<typeof turnArtifacts>[0][number]["artifact"]["kind"];

let seq = 0;
function output(over: {
  artifactId?: string;
  kind?: Kind;
  name?: string;
  runIds?: string[];
  version?: number;
  createdAt?: string;
  baseVersionId?: string;
} = {}) {
  seq += 1;
  const artifactId = over.artifactId ?? `artifact-${seq}`;
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
      executionRunIds: over.runIds ?? ["run-1"],
      inputArtifactVersionIds: [],
      mediaType: "text/markdown",
      projectId: "p1",
      sessionId: "s1",
      version: over.version ?? 1,
      ...(over.baseVersionId ? { baseVersionId: over.baseVersionId } : {}),
    },
  } as never;
}

test("only the versions a run wrote are attached to that run", () => {
  const mine = output({ artifactId: "mine", runIds: ["run-1"] });
  const theirs = output({ artifactId: "theirs", runIds: ["run-2"] });

  const result = turnArtifacts([mine, theirs] as never, "run-1");
  assert.deepEqual(result.visible.map((row) => row.artifact.id), ["mine"]);

  assert.deepEqual(turnArtifacts([mine, theirs] as never, undefined), { visible: [], hidden: 0 });
});

test("a version with no execution provenance is never attached", () => {
  const uploaded = output({ artifactId: "upload", runIds: [] });
  assert.deepEqual(turnArtifacts([uploaded] as never, "run-1"), { visible: [], hidden: 0 });
});

test("one row per artifact, at the highest ordinal", () => {
  const older = output({ artifactId: "report", version: 1 });
  const newer = output({ artifactId: "report", version: 3 });

  const result = turnArtifacts([older, newer] as never, "run-1");
  assert.equal(result.visible.length, 1);
  assert.equal(result.visible[0]!.version.version, 3);
});

test("the ordinal wins over a later timestamp, which import reorders", () => {
  // An imported Session keeps the package's ordinals, but every row can carry the
  // import time as createdAt — the two disagree, and the file's own lineage wins.
  const ordinal = output({ artifactId: "report", version: 3, createdAt: "2026-11-01T00:00:00.000Z" });
  const imported = output({ artifactId: "report", version: 1, createdAt: "2026-11-19T10:00:00.000Z" });

  const result = turnArtifacts([ordinal, imported] as never, "run-1");
  assert.equal(result.visible[0]!.version.version, 3);
});

test("rows are ordered by kind, then newest first, and mark an update", () => {
  const figure = output({ artifactId: "a-figure", kind: "figure", version: 1 });
  const report = output({ artifactId: "b-report", kind: "report", version: 2 });
  const dataset = output({ artifactId: "c-dataset", kind: "dataset", version: 1, baseVersionId: "c-v0" });

  const result = turnArtifacts([figure, dataset, report] as never, "run-1");
  assert.deepEqual(result.visible.map((row) => row.artifact.id), ["b-report", "a-figure", "c-dataset"]);
  assert.equal(result.visible[2]!.updated, true);
  assert.equal(result.visible[0]!.updated, false);
});

test("intermediate kinds are folded behind the important ones", () => {
  const report = output({ artifactId: "report", kind: "report" });
  const dump = output({ artifactId: "dump", kind: "json" });
  const log = output({ artifactId: "log", kind: "other" });

  const result = turnArtifacts([dump, log, report] as never, "run-1");
  assert.deepEqual(result.visible.map((row) => row.artifact.id), ["report"]);
  assert.equal(result.hidden, 2);
});

test("a turn that only produced intermediate kinds still shows them", () => {
  const dump = output({ artifactId: "dump", kind: "json" });
  const log = output({ artifactId: "log", kind: "other" });

  const result = turnArtifacts([dump, log] as never, "run-1");
  assert.equal(result.visible.length, 2);
  assert.equal(result.hidden, 0);
});

test("the strip shows five rows and counts the rest", () => {
  const rows = Array.from({ length: 8 }, (_, index) =>
    output({ artifactId: `artifact-${index}`, kind: "dataset", version: index + 1 }));

  const result = turnArtifacts(rows as never, "run-1");
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

  const result = turnArtifacts(rows as never, "run-1");
  assert.deepEqual(
    result.visible.map((row) => row.artifact.name),
    ["report-1.md", "report-2.md", "report-3.md", "report-4.md", "report-5.md"],
  );
  assert.equal(result.hidden, 2);
});
