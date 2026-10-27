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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { ArtifactReviewRun, ScientificArtifactVersion } from "@sciencediscovery/schema";

import type { SessionStore } from "../store.js";
import { annotateReviewStaleness } from "./review-staleness.js";

function version(artifactId: string, id: string, versionNumber: number): ScientificArtifactVersion {
  return {
    artifactId,
    content: { hash: id, size: 10 },
    createdAt: "2026-10-20T00:00:00.000Z",
    executionRunIds: [],
    id,
    inputArtifactVersionIds: [],
    mediaType: "text/markdown",
    projectId: "project-1",
    sessionId: "session-1",
    turnId: "run-1",
    version: versionNumber,
  };
}

function review(artifactId: string, artifactVersionId: string): ArtifactReviewRun {
  return {
    artifactContentHash: "a".repeat(64),
    artifactId,
    artifactLogicalName: "REPRODUCTION_REPORT.md",
    artifactVersionId,
    checkpointId: "checkpoint-1",
    createdAt: "2026-10-20T00:00:00.000Z",
    decision: "ACCEPT_AND_PROCEED",
    findings: [],
    finishedAt: "2026-10-20T00:00:01.000Z",
    id: `review-${artifactVersionId}`,
    reviewerSpecialistVersion: "2.3.0-deliverable-completeness",
    sessionId: "session-1",
    status: "completed",
  };
}

function fakeStore(versions: ScientificArtifactVersion[]): Pick<SessionStore, "listArtifactVersions"> {
  return {
    listArtifactVersions: (_sessionId: string, artifactId: string) =>
      versions.filter((candidate) => candidate.artifactId === artifactId),
  };
}

test("a review of an outdated Artifact version reads as stale history", () => {
  const versions = [version("artifact-report", "report-v1", 1), version("artifact-report", "report-v2", 2)];
  const [marked] = annotateReviewStaleness(fakeStore(versions), "session-1", [review("artifact-report", "report-v1")]);

  assert.equal(marked?.stale, true);
  assert.equal(marked?.staleSinceVersionId, "report-v2");
  assert.equal(marked?.artifactVersionId, "report-v1", "the reviewed version is not rewritten");
});

test("a review of the current Artifact version stays current", () => {
  const versions = [version("artifact-report", "report-v1", 1), version("artifact-report", "report-v2", 2)];
  const [current, old] = annotateReviewStaleness(fakeStore(versions), "session-1", [
    review("artifact-report", "report-v2"),
    review("artifact-report", "report-v1"),
  ]);

  assert.deepEqual(current, review("artifact-report", "report-v2"));
  assert.equal(current?.stale, undefined);
  assert.equal(old?.stale, true);
});

test("a newer version of a different Artifact does not make a review stale", () => {
  const versions = [
    version("artifact-report", "report-v1", 1),
    version("artifact-dataset", "dataset-v1", 1),
    version("artifact-dataset", "dataset-v2", 2),
  ];
  const [marked] = annotateReviewStaleness(fakeStore(versions), "session-1", [review("artifact-report", "report-v1")]);

  assert.equal(marked?.stale, undefined);
});
