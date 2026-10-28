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
import { fileFolder, fileName } from "../src/app/paths.js";

const { describe, it } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

describe("a label shows the artifact, not the path it lives in", () => {
  it("takes the last segment of a path", () => {
    assert.equal(fileName("antibody_pipeline/runs/antibody-demo-01/ranked.csv"), "ranked.csv");
  });

  it("leaves a bare name alone", () => {
    assert.equal(fileName("ranked.csv"), "ranked.csv");
  });

  it("ignores a trailing separator rather than returning nothing", () => {
    assert.equal(fileName("antibody_pipeline/runs/"), "runs");
  });

  it("keeps a path that has nothing to take", () => {
    assert.equal(fileName(""), "");
    assert.equal(fileName("/"), "/");
  });
});

describe("the folder is what tells two same-named documents apart", () => {
  it("names the nearest folder rather than the whole path to it", () => {
    // `subagents/` is shared by every child, so a truncated prefix would hide
    // the id that actually differs.
    assert.equal(fileFolder("subagents/ab12f/trace.md"), "ab12f");
  });

  it("says nothing for a name with no folder", () => {
    assert.equal(fileFolder("trace.md"), "");
    assert.equal(fileFolder(""), "");
  });

  it("keeps a path with nothing before the separator empty", () => {
    assert.equal(fileFolder("/trace.md"), "");
  });
});
