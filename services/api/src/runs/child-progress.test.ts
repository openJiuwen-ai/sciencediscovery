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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("native child progress broadcasts newest bounded snapshots and clears terminal/cancel timers",async () => {
  const fixture=fileURLToPath(new URL("../../tests/fixtures/child-progress.mjs",import.meta.url));
  const {stdout}=await promisify(execFile)(process.execPath,["--experimental-test-module-mocks","--import","tsx",fixture],{timeout:30000,maxBuffer:1000000});
  assert.match(stdout,/"result":"PASS"/);
});
