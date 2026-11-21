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

import { defersIdeaSend } from "../src/idea/send-gate.js";

test("an Idea Tree command opens the card before it leaves", () => {
  assert.equal(defersIdeaSend("/idea-tree-team", false), true);
  assert.equal(defersIdeaSend("/idea-tree", false), true);
  assert.equal(defersIdeaSend("/idea-tree-team 分析钙钛矿带隙", false), true);
  // The confirmed pass is what actually sends, so it must not defer again.
  assert.equal(defersIdeaSend("/idea-tree-team", true), false);
});

test("every other draft leaves without the card", () => {
  assert.equal(defersIdeaSend("分析一下这个结构", false), false);
  // A command that merely starts with the letters is not the command.
  assert.equal(defersIdeaSend("/idea-tree-teams", false), false);
  assert.equal(defersIdeaSend("/evolve-design 优化", false), false);
});
