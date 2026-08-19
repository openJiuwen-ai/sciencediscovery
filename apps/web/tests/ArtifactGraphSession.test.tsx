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
import test from "node:test";

import { resolveGraphSessionId } from "../src/ScientificArtifacts.js";

// The workspace artifact list is project-scoped (listProjectArtifacts), so an
// artifact opened from it may belong to a different Session than the active
// Session. Memory-graph reads filter by n.session_id, so view-chain must query
// the artifact's own Session or it reports "not yet in the Science Memory".
// These tests pin the three-level fallback of resolveGraphSessionId.

test("prefers the loaded version's own Session (finest grain — handles same-name artifacts produced across Sessions)", () => {
  // Session B first created "report.md" (v1, artifact.createdInSessionId = B),
  // then Session C produced a new version of the same name (v2). The v2 node's
  // session_id is C, so querying B's graph (artifactSessionId) would miss v2;
  // only the version-level sessionId resolves to the right graph.
  const version = { sessionId: "session-c" };
  assert.equal(
    resolveGraphSessionId(version, "session-b", "session-a"),
    "session-c",
  );
});

test("falls back to the caller-pinned Session when no version is loaded yet", () => {
  // openArtifact forwards artifact.createdInSessionId here; the version list
  // hasn't resolved, so version is undefined. Graph reads (view-chain only
  // fires after the version loads, but artifact-provenance's guard uses this
  // path before version.version is truthy) must still target the artifact's
  // Session, not the active Session.
  assert.equal(
    resolveGraphSessionId(undefined, "session-b", "session-a"),
    "session-b",
  );
});

test("falls back to the active Session when neither version nor caller pin is set", () => {
  // Embedded mode (MemoryGraphExplorer) and URL/shared-link paths: the
  // artifact IS the active Session's, so no caller pin is forwarded. Keeps
  // the pre-fix behavior for those paths.
  assert.equal(
    resolveGraphSessionId(undefined, undefined, "session-a"),
    "session-a",
  );
});

test("ignores an empty caller pin and falls through to the active Session", () => {
  // openArtifact pins with `artifact.createdInSessionId || undefined`; a legacy
  // artifact lacking createdInSessionId must not strand graph reads on "".
  assert.equal(
    resolveGraphSessionId(undefined, "", "session-a"),
    "session-a",
  );
});

test("ignores an empty version sessionId and falls through to the caller pin", () => {
  // A version row missing sessionId (older data) must fall through rather than
  // strand graph reads on "".
  assert.equal(
    resolveGraphSessionId({ sessionId: "" }, "session-b", "session-a"),
    "session-b",
  );
});

test("version-level Session wins even when the caller pinned a different Session", () => {
  // Regression guard for same-name-across-Sessions: the caller pin (artifact-
  // level, earliest creator) must NOT override the version-level truth once a
  // version is loaded.
  assert.equal(
    resolveGraphSessionId({ sessionId: "session-c" }, "session-b", "session-a"),
    "session-c",
  );
});
