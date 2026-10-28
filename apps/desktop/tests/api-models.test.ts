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

import * as models from "../src/api/models.js";
import { StubClient, json } from "./api-stub.js";

type ProviderBody = Parameters<typeof models.createProvider>[1];
type ModelBody = Parameters<typeof models.addProviderModel>[2];
type Overrides = Parameters<typeof models.putSettings>[1];

describe("health and catalog", () => {
  it("probes health, forwarding the abort signal it was given", async () => {
    const controller = new AbortController();
    const stub = new StubClient().reply({ status: "ok" });

    const report = await models.getHealth(stub.asClient(), controller.signal);

    assert.deepEqual(report, { status: "ok" });
    assert.equal(stub.calls[0]!.path, "/api/health");
    assert.equal(stub.calls[0]!.init.signal, controller.signal);
  });

  it("reads the provider catalog and the installed models", async () => {
    const stub = new StubClient().reply({}).reply([]);
    const client = stub.asClient();

    await models.listProviders(client);
    await models.listModels(client);

    assert.equal(stub.calls[0]!.path, "/api/providers");
    assert.equal(stub.calls[1]!.path, "/api/models");
  });
});

describe("providers and models", () => {
  it("creates and updates a provider, and previews before saving", async () => {
    const body = { name: "deepseek", type: "openai" } as unknown as ProviderBody;
    const stub = new StubClient().reply({}).reply({}).reply({});
    const client = stub.asClient();

    await models.createProvider(client, body);
    await models.updateProvider(client, "provider/one", body);
    await models.previewProviderModels(client, body);

    assert.equal(stub.calls[0]!.path, "/api/providers");
    assert.equal(stub.calls[0]!.init.method, "POST");
    assert.deepEqual(json(stub.calls[0]!), body);
    assert.equal(stub.calls[1]!.path, "/api/providers/provider%2Fone");
    assert.equal(stub.calls[1]!.init.method, "PUT");
    assert.equal(stub.calls[2]!.path, "/api/providers/preview-models");
    assert.equal(stub.calls[2]!.init.method, "POST");
    // The preview uses the form's values without persisting a provider.
    assert.deepEqual(json(stub.calls[2]!), body);
  });

  it("adds one model to a saved provider", async () => {
    const body = { label: "V3", model: "deepseek-v3" } as unknown as ModelBody;
    const stub = new StubClient().reply({});

    await models.addProviderModel(stub.asClient(), "provider/one", body);

    assert.equal(stub.calls[0]!.path, "/api/providers/provider%2Fone/models");
    assert.equal(stub.calls[0]!.init.method, "POST");
    assert.deepEqual(json(stub.calls[0]!), body);
  });
});

describe("global default model", () => {
  it("reads the current overrides before replacing them", async () => {
    const current = { modelId: "old", enabledSkillIds: ["s1"], skillSelectionMode: "selected" };
    const stub = new StubClient().reply({ overrides: current }).reply({ overrides: { modelId: "new" } });
    const client = stub.asClient();

    const answer = await models.setGlobalModel(client, "model/new");

    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0]!.path, "/api/settings");
    assert.equal(stub.calls[0]!.init.method, undefined);
    assert.equal(stub.calls[1]!.path, "/api/settings");
    assert.equal(stub.calls[1]!.init.method, "PUT");
    // A whole-object PUT: every override not being changed has to travel back.
    assert.deepEqual(json(stub.calls[1]!), {
      enabledSkillIds: ["s1"],
      modelId: "model/new",
      skillSelectionMode: "selected",
    });
    assert.deepEqual(answer, { overrides: { modelId: "new" } });
  });

  it("passes a whole override object through unchanged", async () => {
    const overrides = { modelId: "model/one" } as unknown as Overrides;
    const stub = new StubClient().reply({});

    await models.putSettings(stub.asClient(), overrides);

    assert.equal(stub.calls[0]!.path, "/api/settings");
    assert.equal(stub.calls[0]!.init.method, "PUT");
    assert.deepEqual(json(stub.calls[0]!), overrides);
  });
});

describe("failures", () => {
  it("does not hide a rejected settings read", async () => {
    const failure = new Error("catalog unavailable");
    const stub = new StubClient().fail(failure);

    await assert.rejects(
      () => models.setGlobalModel(stub.asClient(), "model/one"),
      (reason: unknown) => reason === failure,
    );
  });
});
