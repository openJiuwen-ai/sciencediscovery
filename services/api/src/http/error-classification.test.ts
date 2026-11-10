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


import { isKnownClientInputError } from "./error-classification.js";

test("keeps known validation failures at 400 without hiding internal faults", () => {
  for (const message of [
    "Project name is required",
    "modelId must reference an existing model profile",
    "enabledSkillIds contains an unknown value",
    "The LLM base URL must use http or https",
    "Session deletion confirmation does not match the target",
    "Model is referenced by runtime settings and cannot be deleted",
    "Unsafe skill package path: ../escape.txt",
    "Upload filename must be a plain basename without path separators or traversal",
  ]) {
    assert.equal(isKnownClientInputError(new Error(message)), true, message);
  }
  assert.equal(isKnownClientInputError(new SyntaxError("Malformed JSON")), true);
  assert.equal(isKnownClientInputError(new Error("Database invariant failed")), false);
});

test("a length rejection is client input only when it is the whole message", () => {
  // Every store that rejects a caller-supplied string over its limit ends the
  // message with the phrase. Pinned by name, so narrowing the pattern cannot
  // silently drop one.
  for (const message of [
    "The LLM API token is too long",
    "The proxy URL is too long",
    "neo4jHttp is too long",
    "neo4jUser is too long",
    "The Neo4j password is too long",
    "Model ID is too long",
    "The stored runnerToken is too long",
    "pip indexUrl is too long",
  ]) {
    assert.equal(isKnownClientInputError(new Error(message)), true, message);
  }

  // Upstream copy may end the sentence with a period or a line break.
  assert.equal(isKnownClientInputError(new Error("The LLM API token is too long.")), true);
  assert.equal(isKnownClientInputError(new Error("The Neo4j password is too long. \r\n")), true);

  // These carry a filesystem path mid-sentence, so they are server-side faults:
  // the client keeps the generic 500 instead of a body naming the path.
  for (const message of [
    "Runner bundle path is too long for tar: /srv/ws_a/data/model.bin",
    "The remote data directory path is too long for a Unix socket: /tmp/sc-remote/ws_a/.agent.sock",
  ]) {
    assert.equal(isKnownClientInputError(new Error(message)), false, message);
  }

  // Mentioning a length alone is not a validation shape either.
  assert.equal(isKnownClientInputError(new Error("Chunk length 16384 exceeds the internal buffer budget")), false);
});
