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

test("a runtime fault is never client input, whatever its message says", () => {
  // #1533: these are the interpreter reporting a defect in this server, not the
  // caller's bytes. Before this gate the first one matched /cannot/ and the
  // client received `400` with that JavaScript text as the error body.
  for (const fault of [
    new TypeError("Cannot read properties of undefined (reading 'match')"),
    new TypeError("Cannot convert undefined or null to object"),
    new TypeError("Invalid value used as weak map key"),
    new RangeError("Invalid array length"),
    new ReferenceError("params is not defined"),
    new EvalError("invalid eval"),
  ]) {
    assert.equal(isKnownClientInputError(fault), false, `${fault.constructor.name}: ${fault.message}`);
  }

  // The same vocabulary on a plain Error is still the legacy validators' shape,
  // which is the whole reason the wording list is kept.
  assert.equal(isKnownClientInputError(new Error("A model in use cannot be deleted")), true);
  // A body that does not parse is the caller's own bytes.
  assert.equal(isKnownClientInputError(new SyntaxError("Unexpected token in JSON")), true);
});

test("a plain Error quoting the engine's own sentence is not client input either", () => {
  // A handler that re-wraps `cause.message` in a plain Error keeps the engine's
  // wording but loses the class, so the wording itself has to be recognised:
  // #1533 asks that this text never comes back as a 400 body.
  for (const message of [
    "Cannot read properties of undefined (reading 'match')",
    // A handler that prefixes its own sentence keeps the engine's wording.
    "Research package import failed: Cannot read properties of undefined (reading 'match')",
    "Cannot read property 'match' of undefined",
    "Cannot read properties of null (reading 'length')",
    "Cannot set properties of undefined (setting 'enabled')",
    "Cannot set property 'enabled' of undefined",
    "Cannot convert undefined or null to object",
    "Cannot create property 'id' on string 'abc'",
    "Cannot destructure property 'settings' of 'undefined' as it is undefined.",
    "state.specialists.map is not a function",
    "undefined is not iterable",
    "params is not defined",
    "Invalid array length",
    "Maximum call stack size exceeded",
    "Cannot use 'in' operator to search for 'id' in undefined",
    "Assignment to constant variable.",
  ]) {
    assert.equal(isKnownClientInputError(new Error(message)), false, message);
  }

  // The legacy validators keep their 400: these describe the caller's field,
  // and the words "must" / "cannot" are why the wording list still exists.
  for (const message of [
    "after_ms must be a positive integer",
    "SCIENCE_AGENT_MAX_PARALLEL_TOOL_CALLS must be a positive integer",
    "Model is referenced by runtime settings and cannot be deleted",
    "Session deletion confirmation does not match the target",
    "Unsafe skill package path: ../escape.txt",
  ]) {
    assert.equal(isKnownClientInputError(new Error(message)), true, message);
  }
});

test("an error that carries an explicit code is not read from its prose", () => {
  // #1533 names an explicit code as a legitimate source of a 400 beside
  // `ApiStatusError`. The catch-all reads the codes it knows (`CONFLICT`,
  // `INVALID_UPLOAD_PATH`, ...) before this list, so a coded error that still
  // arrives here is a system fault whatever its sentence says.
  for (const fault of [
    Object.assign(new Error("cannot start a transaction within a transaction"), { code: "ERR_SQLITE_ERROR" }),
    Object.assign(new Error("must not lose the audit row"), { code: "ENOTDIR" }),
    Object.assign(new Error("Invalid array length"), { code: "ERR_OUT_OF_RANGE" }),
  ]) {
    assert.equal(isKnownClientInputError(fault), false, `${(fault as { code: string }).code}: ${fault.message}`);
  }

  // An empty code is not a label, so the validator's sentence still decides.
  assert.equal(isKnownClientInputError(Object.assign(new Error("Project name is required"), { code: "" })), true);
});
