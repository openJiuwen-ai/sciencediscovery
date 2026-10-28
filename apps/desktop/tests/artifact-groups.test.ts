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
import { artifactGroups, outputSessionId } from "../src/app/artifact-groups.js";
import type { Session, SessionArtifactOutput } from "../src/api/types.js";

const { describe, it } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

function output(over: {
  artifactId: string;
  /** The Session that created the artifact. */
  creator?: string;
  creatorTitle?: string;
  /** The legacy mirror, used when `creator` is absent. */
  legacy?: string;
  name?: string;
  /** The Session that wrote this version. */
  writer?: string;
  version: number;
  versionId: string;
}): SessionArtifactOutput {
  return {
    artifact: {
      createdInSessionId: over.creator,
      createdInSessionTitle: over.creatorTitle,
      id: over.artifactId,
      kind: "markdown",
      name: over.name ?? "trace.md",
      sessionId: over.legacy,
    },
    version: { id: over.versionId, sessionId: over.writer, version: over.version },
  } as unknown as SessionArtifactOutput;
}

function session(id: string, title: string): Session {
  return { id, title } as never;
}

const UNTITLED = "未命名会话";

describe("the artifact list covers every Session, the open one first", () => {
  it("pins the open Session above the ones the sidebar lists after it", () => {
    const groups = artifactGroups(
      [
        output({ artifactId: "old", creator: "s-old", version: 1, versionId: "v1" }),
        output({ artifactId: "new", creator: "s-now", version: 1, versionId: "v2" }),
        output({ artifactId: "middle", creator: "s-mid", version: 1, versionId: "v3" }),
      ],
      [session("s-old", "上周的会话"), session("s-mid", "昨天的会话"), session("s-now", "正在写的会话")],
      "s-now",
      UNTITLED,
    );
    assert.deepEqual(groups.map((group) => group.sessionId), ["s-now", "s-old", "s-mid"]);
    assert.deepEqual(groups.map((group) => group.isCurrent), [true, false, false]);
  });

  it("groups by the Session that made the artifact, not the one that rewrote it", () => {
    // A later Session rewrites an earlier Session's file. The row stays under
    // the Session that introduced it — a heading that moved whenever someone
    // touched the file would be a heading the reader cannot learn.
    const groups = artifactGroups(
      [
        output({ artifactId: "a", creator: "s-old", version: 1, versionId: "v1", writer: "s-old" }),
        output({ artifactId: "a", creator: "s-old", version: 2, versionId: "v2", writer: "s-now" }),
      ],
      [session("s-now", "正在写的会话"), session("s-old", "上周的会话")],
      "s-now",
      UNTITLED,
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.sessionId, "s-old");
    // One row, on the newest version, whichever Session wrote it.
    assert.deepEqual(groups[0]?.outputs.map((entry) => entry.version.id), ["v2"]);
    // The picker still reaches both (it does its own ordering).
    assert.deepEqual(groups[0]?.versions.map((entry) => entry.version.id).sort(), ["v1", "v2"]);
  });

  it("keeps an artifact whose Session has left the sidebar", () => {
    // The Session was deleted but the file it wrote survives in the Project.
    // Hiding it would hide a readable file; the recorded title still heads it.
    const groups = artifactGroups(
      [output({ artifactId: "orphan", creator: "s-gone", creatorTitle: "已删除的会话", version: 1, versionId: "v1" })],
      [session("s-now", "正在写的会话")],
      "s-now",
      UNTITLED,
    );
    assert.deepEqual(groups.map((group) => group.title), ["已删除的会话"]);
  });

  it("puts output with no Session at all in the open Session's group", () => {
    // Output older than the provenance fields, and an app with no Session open:
    // the empty id is the open Session's, and it is still the current group.
    const groups = artifactGroups(
      [output({ artifactId: "a", version: 1, versionId: "v1" })],
      [],
      undefined,
      UNTITLED,
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.isCurrent, true);
    assert.equal(groups[0]?.sessionId, "");
  });

  it("prefers the live title over the one recorded at creation", () => {
    const groups = artifactGroups(
      [output({ artifactId: "a", creator: "s-1", creatorTitle: "旧名字", version: 1, versionId: "v1" })],
      [session("s-1", "新名字")],
      "s-other",
      UNTITLED,
    );
    assert.equal(groups[0]?.title, "新名字");
  });

  it("falls back to 未命名会话 when nothing can name the Session", () => {
    const groups = artifactGroups(
      [output({ artifactId: "a", creator: "s-1", version: 1, versionId: "v1" })],
      [],
      "s-other",
      UNTITLED,
    );
    assert.equal(groups[0]?.title, UNTITLED);
  });

  it("reads the legacy created-in mirror before the Session that wrote a version", () => {
    assert.equal(outputSessionId(output({ artifactId: "a", legacy: "s-legacy", version: 1, versionId: "v1", writer: "s-writer" })), "s-legacy");
    assert.equal(outputSessionId(output({ artifactId: "a", version: 1, versionId: "v1", writer: "s-writer" })), "s-writer");
    assert.equal(outputSessionId(output({ artifactId: "a", version: 1, versionId: "v1" })), "");
  });

  it("draws nothing for an empty list", () => {
    assert.deepEqual(artifactGroups([], [session("s-1", "会话")], "s-1", UNTITLED), []);
  });
});
