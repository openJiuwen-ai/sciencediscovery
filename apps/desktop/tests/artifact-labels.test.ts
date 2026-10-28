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

import assert from "node:assert/strict";

import { createTest } from "../../../test/support/tagged/compat.mjs";
import { artifactHints, artifactName, artifactPath, latestOutputs, versionsOf } from "../src/app/artifact-labels.js";
import type { SessionArtifactOutput } from "../src/api/types.js";

const { describe, it } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

function output(over: {
  artifactId: string;
  createdAt?: string;
  name: string;
  path?: string;
  title?: string;
  version: number;
  versionId: string;
}): SessionArtifactOutput {
  return {
    artifact: { id: over.artifactId, kind: "markdown", name: over.name, title: over.title },
    version: { createdAt: over.createdAt, id: over.versionId, sourcePath: over.path, version: over.version },
  } as unknown as SessionArtifactOutput;
}

describe("an artifact's row shows its name and where it lives", () => {
  it("prefers the declared title over the file name", () => {
    assert.equal(artifactName(output({ artifactId: "a", name: "app/trace.md", title: "追踪记录", version: 1, versionId: "v1" })), "追踪记录");
    assert.equal(artifactName(output({ artifactId: "a", name: "app/trace.md", version: 1, versionId: "v1" })), "trace.md");
  });

  it("names the source path, or the declared name when the run wrote none", () => {
    assert.equal(artifactPath(output({ artifactId: "a", name: "app/trace.md", path: "app/trace.md", version: 1, versionId: "v1" })), "app/trace.md");
    assert.equal(artifactPath(output({ artifactId: "a", name: "app/trace.md", version: 1, versionId: "v1" })), "app/trace.md");
  });
});

describe("the list is one row per artifact, showing its newest version", () => {
  it("keeps only the latest version of each artifact", () => {
    // A subagent writes `trace.md` and the turn that launched it rewrites the
    // file: two versions of one artifact, one row.
    const outputs = [
      output({ artifactId: "a", name: "trace.md", version: 1, versionId: "v1" }),
      output({ artifactId: "a", name: "trace.md", version: 2, versionId: "v2" }),
      output({ artifactId: "b", name: "answer.txt", version: 1, versionId: "v3" }),
    ];
    assert.deepEqual(latestOutputs(outputs).map((entry) => entry.version.id), ["v2", "v3"]);
  });

  it("does not trust the order the list arrived in", () => {
    const outputs = [
      output({ artifactId: "a", name: "trace.md", version: 2, versionId: "v2" }),
      output({ artifactId: "a", name: "trace.md", version: 1, versionId: "v1" }),
    ];
    assert.deepEqual(latestOutputs(outputs).map((entry) => entry.version.id), ["v2"]);
  });

  it("prefers the later creation when two versions carry the same number", () => {
    const outputs = [
      output({ artifactId: "a", createdAt: "2026-01-01T00:00:00.000Z", name: "trace.md", version: 1, versionId: "early" }),
      output({ artifactId: "a", createdAt: "2026-01-02T00:00:00.000Z", name: "trace.md", version: 1, versionId: "late" }),
    ];
    assert.deepEqual(latestOutputs(outputs).map((entry) => entry.version.id), ["late"]);
  });

  it("leaves an artifact with a single version alone", () => {
    const only = output({ artifactId: "a", name: "trace.md", version: 4, versionId: "v4" });
    assert.deepEqual(latestOutputs([only]), [only]);
    assert.deepEqual(latestOutputs([]), []);
  });

  it("offers every version of one artifact newest first", () => {
    // The order the picker lists them in. Other artifacts' versions are not its
    // business, whichever order the server sent them in.
    const outputs = [
      output({ artifactId: "a", name: "trace.md", version: 2, versionId: "v2" }),
      output({ artifactId: "b", name: "answer.txt", version: 9, versionId: "other" }),
      output({ artifactId: "a", name: "trace.md", version: 3, versionId: "v3" }),
      output({ artifactId: "a", name: "trace.md", version: 1, versionId: "v1" }),
    ];
    assert.deepEqual(versionsOf(outputs, "a").map((entry) => entry.version.id), ["v3", "v2", "v1"]);
    assert.deepEqual(versionsOf(outputs, "missing"), []);
  });
});

describe("the second fact on a row is what tells it from its neighbours", () => {
  it("says nothing when every name is already distinct", () => {
    const hints = artifactHints([
      output({ artifactId: "a", name: "trace.md", path: "app/trace.md", version: 1, versionId: "v1" }),
      output({ artifactId: "b", name: "answer.txt", path: "app/answer.txt", version: 1, versionId: "v2" }),
    ]);
    assert.equal(hints.size, 0);
  });

  it("gives one artifact's versions no hint, because they are one row", () => {
    // The reported case: a subagent writes `app/trace.md`, the turn that
    // launched it rewrites the same file. There is one row now, so there is
    // nothing for a second fact to tell apart.
    const hints = artifactHints([
      output({ artifactId: "a", name: "app/trace.md", path: "subagents/8415d00a/app/trace.md", version: 1, versionId: "v1" }),
      output({ artifactId: "a", name: "app/trace.md", path: "app/trace.md", version: 2, versionId: "v2" }),
    ]);
    assert.equal(hints.size, 0);
  });

  it("names the folder when two artifacts share a name, keyed by artifact", () => {
    const hints = artifactHints([
      output({ artifactId: "a", name: "trace.md", path: "subagents/a1/trace.md", version: 1, versionId: "v1" }),
      output({ artifactId: "b", name: "trace.md", path: "subagents/b2/trace.md", version: 1, versionId: "v2" }),
    ]);
    assert.equal(hints.get("a"), "a1");
    assert.equal(hints.get("b"), "b2");
    assert.equal(hints.size, 2);
  });

  it("falls back to the declared name's folder when a version has no source path", () => {
    const hints = artifactHints([
      output({ artifactId: "a", name: "runs/a/trace.md", version: 1, versionId: "v1" }),
      output({ artifactId: "b", name: "runs/b/trace.md", version: 1, versionId: "v2" }),
    ]);
    assert.equal(hints.get("a"), "a");
    assert.equal(hints.get("b"), "b");
  });
});
