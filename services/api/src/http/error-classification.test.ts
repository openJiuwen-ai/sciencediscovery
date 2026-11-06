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
  // Mentioning a length alone is not a validation shape: a real fault stays a fault.
  assert.equal(isKnownClientInputError(new Error("Chunk length 16384 exceeds the internal buffer budget")), false);
});

test("a length rejection ends with the phrase, so a path-bearing executor fault stays a fault", () => {
  // Every message the classifier means to answer as client input ends with the
  // phrase. Pinned by name, so narrowing the pattern cannot silently drop one.
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

  // These carry a filesystem path in the sentence and only mention the length
  // mid-sentence (`packages/executor`), so they are server-side faults: the
  // client must keep getting the generic 500 instead of the text.
  //
  // The path is a neutral absolute one on purpose: this file ships inside the
  // release payload, and scripts/binary-release/build-payload.sh flags any file
  // carrying the builder's own home directory, so a fixture spelled under the
  // CI builder's home fails the binary-release job as a leaked build path.
  for (const message of [
    "Runner bundle path is too long for tar: /srv/ws_a/data/model.bin",
    "The remote data directory path is too long for a Unix socket: /tmp/sc-remote/ws_a/.agent.sock",
  ]) {
    assert.equal(isKnownClientInputError(new Error(message)), false, message);
  }
});

// Upstream copy may end the sentence with punctuation or a line break. That is
// still the same client-side rejection, not a server fault, so the classifier
// has to look past the terminator and nothing else. One shape per test, so a
// regression names the exact shape it dropped.
test("a length rejection survives a trailing newline", () => {
  assert.equal(isKnownClientInputError(new Error("The LLM API token is too long\n")), true);
});

test("a length rejection survives a trailing period", () => {
  assert.equal(isKnownClientInputError(new Error("The LLM API token is too long.")), true);
});

test("a length rejection survives a trailing period and CRLF", () => {
  assert.equal(isKnownClientInputError(new Error("The Neo4j password is too long. \r\n")), true);
});
