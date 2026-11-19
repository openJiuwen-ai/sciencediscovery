// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import { turnArtifactsByRun } from "../src/app/turn-artifacts.js";

let seq = 0;
function output(runIds: string[], over: { artifactId?: string; version?: number } = {}) {
  seq += 1;
  const artifactId = over.artifactId ?? `artifact-${seq}`;
  return {
    artifact: {
      id: artifactId,
      kind: "report",
      name: `${artifactId}.md`,
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
      createdAt: "2026-11-19T10:00:00.000Z",
      executionRunIds: runIds,
      inputArtifactVersionIds: [],
      mediaType: "text/markdown",
      projectId: "p1",
      sessionId: "s1",
      version: over.version ?? 1,
    },
  } as never;
}

test("one map entry per run that wrote something", () => {
  const first = output(["run-1"], { artifactId: "a-report" });
  const second = output(["run-2"], { artifactId: "b-figure" });
  const orphan = output([], { artifactId: "c-upload" });

  const byRun = turnArtifactsByRun([first, second, orphan] as never);
  assert.deepEqual([...byRun.keys()].sort(), ["run-1", "run-2"]);
  assert.deepEqual(byRun.get("run-1")!.visible.map((row) => row.artifact.id), ["a-report"]);
  assert.deepEqual(byRun.get("run-2")!.visible.map((row) => row.artifact.id), ["b-figure"]);
});

test("a version listing two runs appears under both", () => {
  const shared = output(["run-1", "run-2"], { artifactId: "shared" });
  const byRun = turnArtifactsByRun([shared] as never);
  assert.equal(byRun.get("run-1")!.visible.length, 1);
  assert.equal(byRun.get("run-2")!.visible.length, 1);
});

test("a run that only wrote intermediate kinds still gets an entry", () => {
  const dump = output(["run-3"], { artifactId: "dump" });
  (dump as { artifact: { kind: string } }).artifact.kind = "json";

  const byRun = turnArtifactsByRun([dump] as never);
  assert.equal(byRun.get("run-3")!.visible.length, 1);
  assert.equal(byRun.get("run-3")!.hidden, 0);
});
