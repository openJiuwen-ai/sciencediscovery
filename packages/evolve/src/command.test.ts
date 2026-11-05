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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { evolveCommandApprovesUnisolated } from "./command.js";

test("only the command's own leading run carries the approval", () => {
  assert.equal(evolveCommandApprovesUnisolated("/evolve-design --allow-direct compress better"), true);
  assert.equal(
    evolveCommandApprovesUnisolated("/evolve-design --algorithm puct --allow-direct compress better"),
    true,
  );
  assert.equal(evolveCommandApprovesUnisolated("/evolve-design --algorithm openevolve compress better"), false);
  // A goal that mentions the flag keeps it as text, and text is not consent.
  assert.equal(evolveCommandApprovesUnisolated("/evolve-design explain --allow-direct elsewhere"), false);
  // The flag after a line break is the goal the desktop kept out of the flags.
  assert.equal(evolveCommandApprovesUnisolated("/evolve-design --algorithm puct\n--allow-direct is the goal"), false);
  // The command has to be the message's first word.
  assert.equal(evolveCommandApprovesUnisolated("please /evolve-design --allow-direct"), false);
  assert.equal(evolveCommandApprovesUnisolated("/evolve-designer --allow-direct"), false);
  assert.equal(evolveCommandApprovesUnisolated("--allow-direct"), false);
});
