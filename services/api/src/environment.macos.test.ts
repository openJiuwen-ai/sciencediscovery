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

// A macOS-only case lives in its own file because `compat.mjs` reads the
// platform from the file's tags: a package's plain `node --test` run has no
// plan to select from, so it registers nothing here on a Linux host. The
// shared plan needs no such help — it selects from the tags either way.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:macos", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import {
  DEFAULT_ENVIRONMENT_PACKAGE_SPEC,
  DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC,
} from "@sciencediscovery/executor";

test("macOS package specs use executable paths that exist on macOS", () => {
  assert.equal(JSON.parse(DEFAULT_ENVIRONMENT_PACKAGE_SPEC).executable, process.env.SCIENCE_AGENT_PYTHON_PATH || "/usr/bin/python3");
  assert.equal(JSON.parse(DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC).executable, process.env.SCIENCE_AGENT_SHELL_PATH || "/bin/bash");
});
