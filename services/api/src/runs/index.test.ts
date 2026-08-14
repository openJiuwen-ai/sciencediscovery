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
import { test } from "node:test";

import { splitArtifactVersionSuffix } from "./index.js";

// Regression for the artifact-chip failure: some models collapse the
// artifact_id and version into one string ("uuid#v1") inside
// cites_artifact_aliases. The splitter must recover the bare UUID (so the
// sidecar's composite-key MATCH on a bare artifact_id hits the node) and the
// encoded version (so the cite pins the exact version, not the latest).
test("splitArtifactVersionSuffix strips a #vN suffix into bare id + version", () => {
  assert.deepEqual(
    splitArtifactVersionSuffix("67c0ce25-f5c1-474c-bda3-2dd73865a29a#v1"),
    { id: "67c0ce25-f5c1-474c-bda3-2dd73865a29a", version: 1 },
  );
  assert.deepEqual(
    splitArtifactVersionSuffix("ed2265a4-9638-4b51-a95e-13bf5c1770ac#v2"),
    { id: "ed2265a4-9638-4b51-a95e-13bf5c1770ac", version: 2 },
  );
  assert.deepEqual(
    splitArtifactVersionSuffix("ABC#V12"),
    { id: "ABC", version: 12 },
    "the suffix is case-insensitive and supports multi-digit versions",
  );
});

test("a bare id with no suffix returns version undefined", () => {
  assert.deepEqual(
    splitArtifactVersionSuffix("67c0ce25-f5c1-474c-bda3-2dd73865a29a"),
    { id: "67c0ce25-f5c1-474c-bda3-2dd73865a29a", version: undefined },
  );
  assert.deepEqual(splitArtifactVersionSuffix("plain"), { id: "plain", version: undefined });
});

test("a malformed #v suffix is left whole rather than mis-parsed", () => {
  // Non-numeric version after #v: the whole string stays the id, version
  // undefined — the caller then falls back to the store's latest version.
  assert.deepEqual(
    splitArtifactVersionSuffix("abc#vxyz"),
    { id: "abc#vxyz", version: undefined },
  );
  // An empty version after #v likewise falls through unchanged.
  assert.deepEqual(splitArtifactVersionSuffix("abc#v"), { id: "abc#v", version: undefined });
});

test("an id that merely contains #v mid-string is not split", () => {
  // Only a trailing #vN is stripped; an embedded #v stays part of the id.
  assert.deepEqual(
    splitArtifactVersionSuffix("name#v1/segment"),
    { id: "name#v1/segment", version: undefined },
  );
});
