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
import { projectWithName } from "../src/app/project-name.js";
import type { Project } from "../src/api/types.js";

const { describe, it } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

const PROJECTS = [
  { id: "p1", name: "Notes" },
  { id: "p2", name: "Sepsis study" },
] as Project[];

describe("a Project name is the user's only handle on it", () => {
  it("finds the row that already has it", () => {
    assert.equal(projectWithName(PROJECTS, "Notes")?.id, "p1");
  });

  it("compares the way the list looks, not byte for byte", () => {
    assert.equal(projectWithName(PROJECTS, "  notes ")?.id, "p1");
    assert.equal(projectWithName(PROJECTS, "sepsis   study")?.id, "p2");
  });

  it("lets a name through when only that row has it", () => {
    assert.equal(projectWithName(PROJECTS, "Notes", "p1"), undefined);
    assert.equal(projectWithName(PROJECTS, "Notes", "p2")?.id, "p1");
  });

  it("has nothing to say about a name that is only spaces", () => {
    assert.equal(projectWithName(PROJECTS, "   "), undefined);
  });
});
