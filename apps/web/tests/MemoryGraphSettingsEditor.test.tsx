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

import type { MemoryGraphSettingsDetails } from "@science-agent/schema";

import {
  createMemoryGraphSettingsDraft,
  memoryGraphSettingsRequest,
} from "../src/MemoryGraphSettingsEditor.js";

const settings = {
  enabled: false,
  hasNeo4jPassword: true,
  memoryGraphStatus: "ready",
  neo4jHttp: "http://127.0.0.1:7474",
  neo4jUser: "neo4j",
} satisfies MemoryGraphSettingsDetails;

test("keeps write-only Memory Graph credentials in a deferred request", () => {
  const draft = createMemoryGraphSettingsDraft(settings);

  assert.deepEqual(memoryGraphSettingsRequest({
    ...draft,
    enabled: true,
    password: "  replacement  ",
  }), {
    enabled: true,
    neo4jHttp: settings.neo4jHttp,
    neo4jPassword: "replacement",
    neo4jUser: settings.neo4jUser,
  });

  assert.deepEqual(memoryGraphSettingsRequest({
    ...draft,
    removePassword: true,
  }), {
    enabled: false,
    neo4jHttp: settings.neo4jHttp,
    neo4jPassword: null,
    neo4jUser: settings.neo4jUser,
  });
});
