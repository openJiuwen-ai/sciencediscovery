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

import { formatFileSize } from "../src/app/attachments.js";
import { formatByteLimit } from "../src/app/upload.js";

test("an attachment one byte under 1 MiB prints 1MB, not 1024KB", () => {
  // The card prints the rounded value, so the unit has to be picked from that
  // same rounded value: 1_048_575 bytes is 1023.999 KB unrounded, and a KB
  // value cannot reach 1024.
  assert.equal(formatFileSize(1_048_575), "1MB");
  assert.equal(formatFileSize(1_048_574), "1MB");
});

test("an attachment one byte under 1 GiB prints 1GB, not 1024MB", () => {
  assert.equal(formatFileSize(1_073_741_823), "1GB");
});

test("an upload limit one byte under 1 GiB prints 1 GiB, not 1024 MiB", () => {
  // Same promotion rule in the limit ladder: 1_073_741_823 bytes is 1023.9999… MiB
  // unrounded and "1024.0" once printed, so it belongs in the next unit.
  assert.equal(formatByteLimit(1_073_741_823), "1 GiB");
});

test("the sizes that already read well keep reading the same", () => {
  assert.equal(formatFileSize(0), "0KB");
  assert.equal(formatFileSize(512), "512B");
  assert.equal(formatFileSize(1024), "1KB");
  assert.equal(formatFileSize(5632), "5.5KB");
  assert.equal(formatFileSize(262144), "256KB");
  assert.equal(formatFileSize(1_048_576), "1MB");
  assert.equal(formatFileSize(5 * 1024 * 1024), "5MB");
  assert.equal(formatByteLimit(999), "999 B");
  assert.equal(formatByteLimit(1024), "1 KiB");
  assert.equal(formatByteLimit(1_073_741_824), "1 GiB");
});
