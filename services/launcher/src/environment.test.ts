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
import { describe, test } from "node:test";

import { hasRenamedEnvironmentValue, renamedEnvironmentValue } from "./environment.js";

describe("renamed environment variables", () => {
  test("uses the ScienceDiscovery name without compatibility output", () => {
    const messages: string[] = [];
    const value = renamedEnvironmentValue(
      { SCIENCE_DISCOVERY_DATA_DIR: "/srv/new" },
      "SCIENCE_DISCOVERY_DATA_DIR",
      "SCIENCE_AGENT_DATA_DIR",
      (message) => messages.push(message),
    );
    assert.equal(value, "/srv/new");
    assert.deepEqual(messages, []);
  });

  test("reads the legacy name and reports the fallback", () => {
    const messages: string[] = [];
    const value = renamedEnvironmentValue(
      { SCIENCE_AGENT_DATA_DIR: "/srv/legacy" },
      "SCIENCE_DISCOVERY_DATA_DIR",
      "SCIENCE_AGENT_DATA_DIR",
      (message) => messages.push(message),
    );
    assert.equal(value, "/srv/legacy");
    assert.deepEqual(messages, [
      "[compat] SCIENCE_AGENT_DATA_DIR is deprecated; using its value as SCIENCE_DISCOVERY_DATA_DIR.",
    ]);
  });

  test("prefers the new name and reports the ignored legacy value", () => {
    const messages: string[] = [];
    const env = {
      SCIENCE_AGENT_DATA_DIR: "/srv/legacy",
      SCIENCE_DISCOVERY_DATA_DIR: "/srv/new",
    };
    assert.equal(
      renamedEnvironmentValue(
        env,
        "SCIENCE_DISCOVERY_DATA_DIR",
        "SCIENCE_AGENT_DATA_DIR",
        (message) => messages.push(message),
      ),
      "/srv/new",
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0] as string, /SCIENCE_DISCOVERY_DATA_DIR takes precedence/);
    assert.equal(
      hasRenamedEnvironmentValue(env, "SCIENCE_DISCOVERY_DATA_DIR", "SCIENCE_AGENT_DATA_DIR"),
      true,
    );
  });
});
