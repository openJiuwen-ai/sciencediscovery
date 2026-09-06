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
import test from "node:test";
import { RUNNER_VERSION } from "@sciencediscovery/runner";

import {
  DEFAULT_ENVIRONMENT_PACKAGE_SPEC,
  DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC,
  defaultEnvironmentRevision,
  defaultShellEnvironmentRevision,
} from "./environment.js";

test("host probes preserve the Runner sandbox executable contract", () => {
  const pythonSpec = JSON.parse(DEFAULT_ENVIRONMENT_PACKAGE_SPEC) as { executable?: unknown };
  const shellSpec = JSON.parse(DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC) as { executable?: unknown };

  assert.equal(pythonSpec.executable, "/usr/bin/python3");
  assert.equal(shellSpec.executable, process.platform === "darwin" ? "/bin/bash" : "/usr/bin/bash");
  assert.match(defaultEnvironmentRevision().languageVersion, /^Python 3\./);
  assert.match(defaultShellEnvironmentRevision().languageVersion, /^GNU bash, version /);
});

test("system environment provenance uses the shipped Runner build", () => {
  assert.equal(defaultEnvironmentRevision().runnerVersion, RUNNER_VERSION);
  assert.equal(defaultShellEnvironmentRevision().runnerVersion, RUNNER_VERSION);
  assert.equal(JSON.parse(DEFAULT_ENVIRONMENT_PACKAGE_SPEC).runner, RUNNER_VERSION);
  assert.equal(JSON.parse(DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC).runner, RUNNER_VERSION);
});
