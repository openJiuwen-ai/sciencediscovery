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
import type { WorkspaceFile } from "../src/api/types.js";
import { changedFiles } from "../src/app/file-changes.js";

const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

function file(path: string, size = 10, modifiedAt = "2026-10-27T10:00:00.000Z"): WorkspaceFile {
  return { modifiedAt, path, size };
}

describe("which workspace files the panel reads again", () => {
  it("names the file the run just wrote", () => {
    const before = [file("report.md"), file("notes.md")];
    const after = [file("report.md", 42, "2026-10-27T10:00:05.000Z"), file("notes.md")];
    assert.deepEqual(changedFiles(before, after).map((entry) => entry.path), ["report.md"]);
  });

  it("counts a rewritten file by size or by time, whichever moved", () => {
    const before = [file("report.md", 10, "2026-10-27T10:00:00.000Z")];
    assert.equal(changedFiles(before, [file("report.md", 11, "2026-10-27T10:00:00.000Z")]).length, 1);
    assert.equal(changedFiles(before, [file("report.md", 10, "2026-10-27T10:00:01.000Z")]).length, 1);
  });

  it("leaves an untouched file alone", () => {
    const files = [file("report.md"), file("notes.md")];
    assert.deepEqual(changedFiles(files, files.map((entry) => ({ ...entry }))), []);
  });

  it("treats the first listing as every file being new", () => {
    assert.deepEqual(changedFiles([], [file("report.md")]).map((entry) => entry.path), ["report.md"]);
  });

  it("says nothing about a file that is gone", () => {
    assert.deepEqual(changedFiles([file("report.md"), file("old.md")], [file("report.md")]), []);
  });
});
