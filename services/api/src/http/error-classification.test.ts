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


import { isInternalFault, isKnownClientInputError } from "./error-classification.js";

test("a runtime error or a system-coded error is never claimed as client input", () => {
  // The #1520 instance and its siblings: the prose says "cannot"/"invalid", but
  // the exception is this server dereferencing something that was not there.
  const runtimeFaults = [
    new TypeError("Cannot read properties of undefined (reading 'match')"),
    new TypeError("Invalid value used as weak map key"),
    new RangeError("Invalid array length"),
    new ReferenceError("helper is not defined"),
  ];
  for (const fault of runtimeFaults) {
    assert.equal(isInternalFault(fault), true, fault.message);
    assert.equal(isKnownClientInputError(fault), false, `the word list must not claim: ${fault.message}`);
  }
  // Node, the filesystem and dependencies tag their failures with a stable code.
  const coded = Object.assign(new Error("sqlite cannot start a transaction within a transaction"), { code: "ERR_SQLITE_ERROR" });
  assert.equal(isInternalFault(coded), true);
  assert.equal(isKnownClientInputError(coded), false);
  // A SyntaxError is still the parser's way of naming the caller's bad JSON.
  assert.equal(isInternalFault(new SyntaxError("Malformed JSON")), false);
  assert.equal(isKnownClientInputError(new SyntaxError("Malformed JSON")), true);
});

test("the legacy list still answers the plain Error the stores throw", () => {
  // The store validators have no code and no type; the list is their only 400.
  for (const message of ["Notification page must contain 1-100 entries", "modelId is required"]) {
    const fault = new Error(message);
    assert.equal(isInternalFault(fault), false, message);
    assert.equal(isKnownClientInputError(fault), true, message);
  }
});

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
  // A real internal fault must keep the generic 500; the settings route relies on
  // this, so tagging one more rejection as client input must not widen the class.
  for (const message of ["Database invariant failed", "Catalog database is not initialized"]) {
    assert.equal(isKnownClientInputError(new Error(message)), false, message);
  }
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
