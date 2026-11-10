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
import { sizeInUnit } from "../src/app/size-units.js";
import { formatByteLimit } from "../src/app/upload.js";
import { formatFreeSpace } from "../src/views/SetupWizard.js";
import { formatWorkspaceSize } from "../src/views/WorkspacePanel.js";

test("the ladder itself puts the boundary in the unit the caller prints", () => {
  // Pinned on the shared rule, not only through a caller: one byte under 1 MiB
  // is 1023.999 KB, and a whole-number printer reads that as 1024 — the base of
  // its level — so the ladder climbs to MB and leaves 0.999999 MB to print as
  // 1MB. Zero never climbs.
  const whole = (value: number) => Math.round(value);
  const boundary = sizeInUnit(1_048_575, whole, 4);
  assert.equal(boundary.unit, 2, "the boundary belongs to MB, not to a 1024KB");
  assert.equal(whole(boundary.value), 1, "and the caller prints 1MB from it");
  assert.deepEqual(sizeInUnit(0, whole, 4), { unit: 0, value: 0 });
});

test("an attachment one byte under 1 MiB reads 1MB, not 1024KB", () => {
  // The card prints a whole number above a hundred units, so the unit has to be
  // chosen from that same number: 1_048_575 bytes is 1023.999 KB unrounded, and a
  // KB value cannot reach 1024.
  assert.equal(formatFileSize(1_048_575), "1MB");
  assert.equal(formatFileSize(1_048_574), "1MB");
});

test("an attachment one byte under 1 GiB reads 1GB, not 1024MB", () => {
  assert.equal(formatFileSize(1_073_741_823), "1GB");
});

test("an upload limit one byte under 1 GiB reads 1 GiB, not 1024 MiB", () => {
  assert.equal(formatByteLimit(1_073_741_823), "1 GiB");
});

test("a workspace row one byte under a unit reads the next unit, not 1024 of this one", () => {
  assert.equal(formatWorkspaceSize(1_048_575), "1.0 MiB");
  assert.equal(formatWorkspaceSize(1_073_741_823), "1.0 GiB");
});

test("the wizard's free-space line promotes on the number it prints", () => {
  // KB and MB print as whole numbers there, so the band just under the next unit
  // has to promote as well: 1_048_064 bytes is 1023.5 KB and reads 1024KB otherwise.
  assert.equal(formatFreeSpace(1_048_575), "1MB");
  assert.equal(formatFreeSpace(1_048_064), "1MB");
  assert.equal(formatFreeSpace(1_073_741_823), "1.0GB");
  assert.equal(formatFreeSpace(1_073_600_000), "1.0GB");
});

test("the sizes that already read well keep reading the same", () => {
  assert.equal(formatFileSize(0), "0KB");
  assert.equal(formatFileSize(512), "512B");
  assert.equal(formatFileSize(1024), "1KB");
  assert.equal(formatFileSize(5632), "5.5KB");
  assert.equal(formatFileSize(262144), "256KB");
  assert.equal(formatFileSize(1_048_576), "1MB");
  assert.equal(formatByteLimit(999), "999 B");
  assert.equal(formatByteLimit(1024), "1 KiB");
  assert.equal(formatByteLimit(1_073_741_824), "1 GiB");
  assert.equal(formatWorkspaceSize(1_023), "1023 B");
  assert.equal(formatWorkspaceSize(1_500_000), "1.4 MiB");
  assert.equal(formatFreeSpace(1_048_063), "1023KB");
  assert.equal(formatFreeSpace(1_073_217_535), "1023MB");
  assert.equal(formatFreeSpace(500_000), "488KB");
  assert.equal(formatFreeSpace(45_000_000_000), "41.9GB");
});
