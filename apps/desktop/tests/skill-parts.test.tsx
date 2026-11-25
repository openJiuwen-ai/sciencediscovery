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

import React from "react";
import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { CaretGlyph } from "../src/views/settings/skill-tree-glyphs.js";
import { MARK_TONES, markTone } from "../src/views/settings/skill-tone.js";
import { act, create } from "./support/dom-renderer.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

test("a Skill's mark tone is stable and one of the handoff's five", () => {
  assert.equal(markTone("review"), markTone("review"));
  for (const name of ["13c-metabolic-flux", "黄金价格分析", "review", ""]) {
    assert.ok(MARK_TONES.includes(markTone(name)), `${name} has no tone`);
  }
});

test("the tree caret points up when open and right when closed", async () => {
  const pathOf = async (open: boolean): Promise<string | undefined> => {
    let view: ReturnType<typeof create> | undefined;
    await act(async () => { view = create(<CaretGlyph open={open} />); });
    assert.ok(view);
    const path = view.root.findAllByType("path")[0];
    assert.ok(path);
    return path.props.d;
  };
  const open = await pathOf(true);
  const closed = await pathOf(false);
  assert.ok(open && closed);
  assert.notEqual(open, closed, "the caret does not change direction");
});
