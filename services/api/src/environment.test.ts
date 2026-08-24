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
import { test } from "node:test";

import {
  SYSTEM_PYTHON_ENVIRONMENT_REVISION_ID,
  SYSTEM_PYTHON_SEATBELT_ENVIRONMENT_REVISION_ID,
  SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
  SYSTEM_SHELL_SEATBELT_ENVIRONMENT_REVISION_ID,
} from "@sciencediscovery/schema";

import {
  DEFAULT_ENVIRONMENT_PACKAGE_SPEC,
  DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC,
  hostSandboxKind,
  systemPythonEnvironmentRevisionId,
  systemShellEnvironmentRevisionId,
} from "@sciencediscovery/executor";

test("system environment revisions follow the selected native sandbox", () => {
  assert.equal(hostSandboxKind("linux"), "bubblewrap");
  assert.equal(hostSandboxKind("darwin"), "seatbelt");
  assert.equal(systemPythonEnvironmentRevisionId("bubblewrap"), SYSTEM_PYTHON_ENVIRONMENT_REVISION_ID);
  assert.equal(systemPythonEnvironmentRevisionId("seatbelt"), SYSTEM_PYTHON_SEATBELT_ENVIRONMENT_REVISION_ID);
  assert.equal(systemShellEnvironmentRevisionId("bubblewrap"), SYSTEM_SHELL_ENVIRONMENT_REVISION_ID);
  assert.equal(systemShellEnvironmentRevisionId("seatbelt"), SYSTEM_SHELL_SEATBELT_ENVIRONMENT_REVISION_ID);
});

test("macOS package specs use executable paths that exist on macOS", { skip: process.platform !== "darwin" }, () => {
  assert.equal(JSON.parse(DEFAULT_ENVIRONMENT_PACKAGE_SPEC).executable, process.env.SCIENCE_AGENT_PYTHON_PATH || "/usr/bin/python3");
  assert.equal(JSON.parse(DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC).executable, process.env.SCIENCE_AGENT_SHELL_PATH || "/bin/bash");
});
