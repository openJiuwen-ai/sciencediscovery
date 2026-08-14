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

import { strFromU8, strToU8, unzipSync } from "fflate";

import {
  artifactArchiveLimitError,
  artifactDownloadFileName,
  createArtifactArchive,
  MAX_ARTIFACT_ARCHIVE_BYTES,
  MAX_ARTIFACT_ARCHIVE_FILES,
  normalizeArtifactArchivePath,
} from "../src/artifact-download.js";

test("artifact archive paths preserve safe logical directories", () => {
  assert.equal(normalizeArtifactArchivePath("e\\f\\g.md"), "e/f/g.md");
  assert.equal(normalizeArtifactArchivePath("a//./out.csv"), "a/out.csv");
  assert.equal(artifactDownloadFileName("reports/cohort-summary.csv"), "cohort-summary.csv");

  for (const unsafe of ["", "/absolute.csv", "C:\\absolute.csv", "../escape.csv", "a/../escape.csv"]) {
    assert.throws(() => normalizeArtifactArchivePath(unsafe));
  }
});

test("artifact archive limits allow the boundary and reject oversized selections", () => {
  assert.equal(artifactArchiveLimitError(MAX_ARTIFACT_ARCHIVE_FILES, MAX_ARTIFACT_ARCHIVE_BYTES), undefined);
  assert.match(artifactArchiveLimitError(MAX_ARTIFACT_ARCHIVE_FILES + 1, 0) ?? "", /at most 100/);
  assert.match(artifactArchiveLimitError(1, MAX_ARTIFACT_ARCHIVE_BYTES + 1) ?? "", /100 MiB/);
});

test("artifact ZIP entries retain logical paths and round-trip their content", async () => {
  const archive = await createArtifactArchive([
    { content: strToU8("alpha,value\nA,1"), name: "a/out.csv" },
    { content: strToU8("beta,value\nB,2"), name: "b/out.csv" },
  ]);
  const files = unzipSync(archive);

  assert.deepEqual(Object.keys(files).sort(), ["a/out.csv", "b/out.csv"]);
  assert.equal(strFromU8(files["a/out.csv"]!), "alpha,value\nA,1");
  assert.equal(strFromU8(files["b/out.csv"]!), "beta,value\nB,2");
});

test("artifact ZIP generation rejects duplicate normalized logical paths", async () => {
  await assert.rejects(createArtifactArchive([
    { content: strToU8("first"), name: "a//out.csv" },
    { content: strToU8("second"), name: "a/out.csv" },
  ]), /Duplicate artifact path/);
});
