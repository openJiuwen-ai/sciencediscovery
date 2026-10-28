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

import { decidePermissionRequest } from "../src/api/permissions.js";
import type { PermissionDecision } from "../src/api/types.js";
import { StubClient, json } from "./api-stub.js";

type Decision = Parameters<typeof decidePermissionRequest>[2];

describe("answering a permission request", () => {
  it("posts the decision to the request's own route", async () => {
    const result = { request: { id: "req/one" }, resolvedRequests: ["req/one", "req/two"] };
    const stub = new StubClient().reply(result);

    const answer = await decidePermissionRequest(stub.asClient(), "req/one", "allow" as Decision);

    assert.equal(stub.calls[0]!.path, "/api/permission-requests/req%2Fone/decision");
    assert.equal(stub.calls[0]!.init.method, "POST");
    assert.deepEqual(json(stub.calls[0]!), { decision: "allow" });
    // The response is the whole picture: `allow_matching` resolves siblings too.
    assert.deepEqual(answer, result);
  });

  it("keeps each decision distinct on the wire", async () => {
    const stub = new StubClient().reply({}).reply({});
    const client = stub.asClient();
    const decisions: PermissionDecision[] = ["allow", "deny"];

    await decidePermissionRequest(client, "req/one", decisions[0]!);
    await decidePermissionRequest(client, "req/one", decisions[1]!);

    assert.deepEqual(json(stub.calls[0]!), { decision: "allow" });
    assert.deepEqual(json(stub.calls[1]!), { decision: "deny" });
  });

  it("hands a failed decision back to the caller", async () => {
    const failure = new Error("request already resolved");
    const stub = new StubClient().fail(failure);

    await assert.rejects(
      () => decidePermissionRequest(stub.asClient(), "req/one", "allow" as Decision),
      (reason: unknown) => reason === failure,
    );
  });
});
