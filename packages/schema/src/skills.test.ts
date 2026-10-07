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

/**
 * Additive-schema guard: the optional `metadata` field on
 * `SkillVersionProvenance` and the bulk Git publish request/response types
 * must accept old payloads unchanged and round-trip new ones.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type {
  BulkPublishGitSkillReviewDraftsRequest,
  BulkPublishGitSkillReviewDraftsResponse,
  SkillVersionProvenance,
} from "./skills.js";

test("SkillVersionProvenance accepts legacy payloads and round-trips metadata", () => {
  const legacy = JSON.parse('{"source":"git"}') as SkillVersionProvenance;
  assert.equal(legacy.metadata, undefined);
  assert.equal(legacy.source, "git");

  const withMetadata: SkillVersionProvenance = {
    git: { commit: "1234567890abcdef1234567890abcdef12345678", repositoryUrl: "https://example.com/repo.git", subdirectory: "skills/a" },
    metadata: { autoImportedAt: "2026-01-02T03:04:05.000Z", autoImportPresetId: "https://example.com/repo.git" },
    source: "git",
  };
  const roundTripped = JSON.parse(JSON.stringify(withMetadata)) as SkillVersionProvenance;
  assert.deepEqual(roundTripped, withMetadata);
  assert.equal(roundTripped.metadata?.autoImportPresetId, "https://example.com/repo.git");
});

test("bulk Git publish request and response shapes stay stable", () => {
  const minimal = JSON.parse('{"draftIds":["d1","d2"]}') as BulkPublishGitSkillReviewDraftsRequest;
  assert.deepEqual(minimal.draftIds, ["d1", "d2"]);
  assert.equal(minimal.onConflict, undefined);
  assert.equal(minimal.libraryId, undefined);
  assert.equal(minimal.presetId, undefined);

  const full: BulkPublishGitSkillReviewDraftsRequest = {
    draftIds: ["d1"],
    libraryId: "project-skills",
    onConflict: "filter",
    presetId: "https://example.com/repo.git",
  };
  assert.deepEqual(JSON.parse(JSON.stringify(full)), full);

  const empty = JSON.parse('{"conflicts":[],"diagnostics":[],"skipped":[]}') as BulkPublishGitSkillReviewDraftsResponse;
  assert.deepEqual(empty.conflicts, []);
  assert.equal(empty.version, undefined);
});
