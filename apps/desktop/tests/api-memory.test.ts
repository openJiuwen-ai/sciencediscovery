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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import { listMemoryNodes, memoryChain } from "../src/api/memory.js";
import { StubClient, json } from "./api-stub.js";

describe("the memory card list", () => {
  it("asks for the two kinds in one scoped read", async () => {
    const stub = new StubClient().reply({ hits: [], total: 0, truncated: false });
    const client = stub.asClient();

    await listMemoryNodes(client, ["Evidence", "Artifact"], "session/one");

    assert.equal(stub.calls[0]!.path, "/api/memory/query/by-node-type");
    assert.equal(stub.calls[0]!.init.method, "POST");
    assert.deepEqual(json(stub.calls[0]!), {
      node_types: ["Evidence", "Artifact"],
      session_id: "session/one",
    });
  });

  it("omits the session for the all-sessions scope", async () => {
    const stub = new StubClient().reply({ hits: [], total: 0, truncated: false });

    // The optional argument is left out rather than passed as `undefined`:
    // same call, and the mirror's CodeCheck does not read it as a value.
    await listMemoryNodes(stub.asClient(), ["Evidence", "Artifact"]);

    assert.deepEqual(json(stub.calls[0]!), { node_types: ["Evidence", "Artifact"] });
  });
});

describe("one provenance hop", () => {
  it("names the node, its session and the button's kind", async () => {
    const stub = new StubClient().reply({ nodes: [], edges: [], total: 0, truncated: false });
    const client = stub.asClient();

    await memoryChain(client, "artifact#v2", "session/one", "viewContainedClaims", 2);

    assert.equal(stub.calls[0]!.path, "/api/memory/query/chain");
    assert.equal(stub.calls[0]!.init.method, "POST");
    assert.deepEqual(json(stub.calls[0]!), {
      node_id: "artifact#v2",
      session_id: "session/one",
      version: 2,
      kind: "viewContainedClaims",
    });
  });

  it("leaves the version out when the node does not carry one", async () => {
    const stub = new StubClient().reply({ nodes: [], edges: [], total: 0, truncated: false });

    await memoryChain(stub.asClient(), "evidence-1", "session/one", "viewSourcePaper");

    assert.deepEqual(json(stub.calls[0]!), {
      node_id: "evidence-1",
      session_id: "session/one",
      kind: "viewSourcePaper",
    });
  });
});
