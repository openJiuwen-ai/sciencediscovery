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

import { formatStars } from "../src/app/use-github-stars.js";

test("a count below a thousand is shown as it is", () => {
  assert.equal(formatStars(0), "0");
  assert.equal(formatStars(999), "999");
});

test("a count above a thousand keeps one decimal, the way GitHub abbreviates", () => {
  assert.equal(formatStars(1000), "1.0k");
  assert.equal(formatStars(5432), "5.4k");
  assert.equal(formatStars(19999), "20.0k");
});
