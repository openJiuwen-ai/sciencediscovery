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

import * as settings from "../src/api/settings.js";
import { StubClient, json } from "./api-stub.js";

type Overrides = Parameters<typeof settings.putGlobalSettings>[1];
type EnvironmentSourceBody = Parameters<typeof settings.updateEnvironmentSource>[1];
type ProxyDefault = Parameters<typeof settings.updateProxyDefault>[1];
type ProxyPolicies = Parameters<typeof settings.updateMcpProxyPolicies>[1];
type SandboxNetwork = Parameters<typeof settings.updateSandboxNetwork>[1];
type TimeoutSettings = Parameters<typeof settings.updateTimeoutSettings>[1];
type QuotaSettings = Parameters<typeof settings.updateQuotaSettings>[1];
type McpServerBody = Parameters<typeof settings.saveMcpServer>[1];
type WebBody = Parameters<typeof settings.updateWebSettings>[1];
type MemoryBody = Parameters<typeof settings.updateMemoryGraphSettings>[1];
type IdeaTreeBody = Parameters<typeof settings.updateIdeaTreeSettings>[1];
type CreateSpecialistBody = Parameters<typeof settings.createSpecialist>[1];
type UpdateSpecialistBody = Parameters<typeof settings.updateSpecialist>[2];

describe("runtime settings layers", () => {
  it("reads and replaces both the global and the project layer", async () => {
    const overrides = { modelId: "model/one" } as unknown as Overrides;
    const stub = new StubClient().reply({}).reply({}).reply({}).reply({});
    const client = stub.asClient();

    await settings.getGlobalSettings(client);
    await settings.putGlobalSettings(client, overrides);
    await settings.getProjectSettings(client, "project/one");
    await settings.putProjectSettings(client, "project/one", overrides);

    assert.equal(stub.calls[0]!.path, "/api/settings");
    assert.equal(stub.calls[0]!.init.method, undefined);
    assert.equal(stub.calls[1]!.path, "/api/settings");
    assert.equal(stub.calls[1]!.init.method, "PUT");
    assert.deepEqual(json(stub.calls[1]!), overrides);
    assert.equal(stub.calls[2]!.path, "/api/projects/project%2Fone/settings");
    assert.equal(stub.calls[3]!.path, "/api/projects/project%2Fone/settings");
    assert.equal(stub.calls[3]!.init.method, "PUT");
    assert.deepEqual(json(stub.calls[3]!), overrides);
  });

  it("sends only the named field when updating the environment source", async () => {
    const body = { pipSource: "pypi" } as unknown as EnvironmentSourceBody;
    const stub = new StubClient().reply({}).reply({});
    const client = stub.asClient();

    await settings.getEnvironmentSource(client);
    await settings.updateEnvironmentSource(client, body);

    assert.equal(stub.calls[0]!.path, "/api/environment-source-settings");
    assert.equal(stub.calls[1]!.init.method, "PUT");
    assert.deepEqual(json(stub.calls[1]!), body);
  });
});

describe("skills", () => {
  it("reads connectors and the installed skill catalog", async () => {
    const stub = new StubClient().reply([]).reply([]);
    const client = stub.asClient();

    await settings.listConnectors(client);
    await settings.listSkills(client);

    assert.equal(stub.calls[0]!.path, "/api/connectors");
    assert.equal(stub.calls[1]!.path, "/api/skills");
  });

  it("pins the selection mode and keeps every other override when one skill moves", async () => {
    // `all` is the default mode and would overwrite the ids on the next read,
    // so the write has to carry `selected` in the same body.
    const stub = new StubClient()
      .reply({
        effective: {},
        overrides: { enabledSkillIds: ["old"], modelId: "model/one", skillSelectionMode: "all" },
        sources: {},
      })
      .reply({});
    const client = stub.asClient();

    await settings.setEnabledSkills(client, "project/one", ["new"]);

    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0]!.path, "/api/projects/project%2Fone/settings");
    assert.equal(stub.calls[1]!.path, "/api/projects/project%2Fone/settings");
    assert.equal(stub.calls[1]!.init.method, "PUT");
    assert.deepEqual(json(stub.calls[1]!), {
      enabledSkillIds: ["new"],
      modelId: "model/one",
      skillSelectionMode: "selected",
    });
  });
});

describe("network", () => {
  it("uses the proxy and MCP policy routes", async () => {
    const stub = new StubClient()
      .reply([])
      .reply({})
      .reply({})
      .reply({})
      .reply({})
      .reply({})
      .reply({});
    const client = stub.asClient();

    await settings.listMcpSources(client);
    await settings.updateProxyDefault(client, "direct" as unknown as ProxyDefault);
    await settings.createProxyServer(client, { kind: "http", name: "office", url: "http://proxy:8080" });
    await settings.updateProxyServer(client, "server/one", { name: "renamed" });
    await settings.deleteProxyServer(client, "server/one");
    await settings.getMcpProxyPolicies(client);
    await settings.updateMcpProxyPolicies(client, { one: "inherit" } as unknown as ProxyPolicies);

    assert.equal(stub.calls[0]!.path, "/api/mcp/sources");
    assert.equal(stub.calls[1]!.path, "/api/proxy/settings");
    assert.equal(stub.calls[1]!.init.method, "PUT");
    assert.deepEqual(json(stub.calls[1]!), { defaultPolicy: "direct" });
    assert.equal(stub.calls[2]!.path, "/api/proxy/servers");
    assert.equal(stub.calls[2]!.init.method, "POST");
    assert.equal(stub.calls[3]!.path, "/api/proxy/servers/server%2Fone");
    assert.equal(stub.calls[3]!.init.method, "PUT");
    assert.equal(stub.calls[4]!.path, "/api/proxy/servers/server%2Fone");
    assert.equal(stub.calls[4]!.init.method, "DELETE");
    assert.equal(stub.calls[5]!.path, "/api/mcp/proxy-policies");
    assert.equal(stub.calls[6]!.path, "/api/mcp/proxy-policies");
    assert.deepEqual(json(stub.calls[6]!), { policies: { one: "inherit" } });
  });

  it("reads and replaces the sandbox network policy", async () => {
    const body = { allowedDomains: ["example.com"], mode: "allowlist" } as unknown as SandboxNetwork;
    const stub = new StubClient().reply({}).reply({});
    const client = stub.asClient();

    await settings.getSandboxNetwork(client);
    await settings.updateSandboxNetwork(client, body);

    assert.equal(stub.calls[0]!.path, "/api/sandbox-network-settings");
    assert.equal(stub.calls[1]!.path, "/api/sandbox-network-settings");
    assert.equal(stub.calls[1]!.init.method, "PUT");
    assert.deepEqual(json(stub.calls[1]!), body);
  });
});

describe("runtime and runners", () => {
  it("reads runtime status and tears one kernel down", async () => {
    const stub = new StubClient().reply({}).reply({});
    const client = stub.asClient();

    await settings.getRuntimeStatus(client);
    await settings.teardownKernel(client, "kernel/one");

    assert.equal(stub.calls[0]!.path, "/api/runtime-status");
    assert.equal(stub.calls[1]!.path, "/api/runtime-status/kernels/kernel%2Fone/teardown");
    assert.equal(stub.calls[1]!.init.method, "POST");
  });

  it("probes a Runner and picks the connect or disconnect route", async () => {
    const stub = new StubClient().reply({}).reply({}).reply({});
    const client = stub.asClient();

    await settings.probeRunner(client, "runner/one");
    await settings.setRunnerConnected(client, "runner/one", true);
    await settings.setRunnerConnected(client, "runner/one", false);

    assert.equal(stub.calls[0]!.path, "/api/runners/runner%2Fone/probe");
    assert.equal(stub.calls[0]!.init.method, "POST");
    assert.equal(stub.calls[1]!.path, "/api/runners/runner%2Fone/connect");
    assert.equal(stub.calls[2]!.path, "/api/runners/runner%2Fone/disconnect");
  });

  it("reads and replaces timeouts and quotas", async () => {
    const timeouts = { idleKernelSeconds: 0 } as unknown as TimeoutSettings;
    const quotas = { workspaceBytes: 0 } as unknown as QuotaSettings;
    const stub = new StubClient().reply({}).reply({}).reply({}).reply({});
    const client = stub.asClient();

    await settings.getTimeoutSettings(client);
    await settings.updateTimeoutSettings(client, timeouts);
    await settings.getQuotaSettings(client);
    await settings.updateQuotaSettings(client, quotas);

    assert.equal(stub.calls[0]!.path, "/api/timeout-settings");
    assert.equal(stub.calls[1]!.path, "/api/timeout-settings");
    assert.deepEqual(json(stub.calls[1]!), timeouts);
    assert.equal(stub.calls[2]!.path, "/api/quota-settings");
    assert.equal(stub.calls[3]!.path, "/api/quota-settings");
    assert.deepEqual(json(stub.calls[3]!), quotas);
  });

  it("lists Runners and replaces one machine's NPU selection", async () => {
    const stub = new StubClient().reply([]).reply({}).reply({});
    const client = stub.asClient();

    await settings.listRunners(client);
    await settings.listRunnerNpuDevices(client);
    await settings.setRunnerNpuDevices(client, "runner/one", [0, 2]);

    assert.equal(stub.calls[0]!.path, "/api/runners");
    assert.equal(stub.calls[1]!.path, "/api/runners/npu");
    assert.equal(stub.calls[2]!.path, "/api/runners/runner%2Fone/npu-devices");
    assert.equal(stub.calls[2]!.init.method, "PUT");
    assert.deepEqual(json(stub.calls[2]!), { devices: [0, 2] });
  });
});

describe("MCP servers", () => {
  it("creates with POST, updates with PUT at the same path, and tests and deletes by id", async () => {
    const body = { name: "pubmed" } as unknown as McpServerBody;
    const stub = new StubClient().reply([]).reply({}).reply({}).reply({}).reply({});
    const client = stub.asClient();

    await settings.listMcpServers(client);
    await settings.saveMcpServer(client, body);
    await settings.saveMcpServer(client, body, "server/one");
    await settings.testMcpServer(client, "server/one");
    await settings.deleteMcpServer(client, "server/one");

    assert.equal(stub.calls[0]!.path, "/api/mcp/servers");
    assert.equal(stub.calls[1]!.path, "/api/mcp/servers");
    assert.equal(stub.calls[1]!.init.method, "POST");
    assert.deepEqual(json(stub.calls[1]!), body);
    assert.equal(stub.calls[2]!.path, "/api/mcp/servers/server%2Fone");
    assert.equal(stub.calls[2]!.init.method, "PUT");
    assert.equal(stub.calls[3]!.path, "/api/mcp/servers/server%2Fone/test");
    assert.equal(stub.calls[3]!.init.method, "POST");
    assert.equal(stub.calls[4]!.path, "/api/mcp/servers/server%2Fone");
    assert.equal(stub.calls[4]!.init.method, "DELETE");
  });
});

describe("web, memory and Idea Tree", () => {
  it("keeps each surface on its own route and sends whole-object writes", async () => {
    const web = { searchEngine: "bing" } as unknown as WebBody;
    const memory = { enabled: true } as unknown as MemoryBody;
    const idea = { enabled: false } as unknown as IdeaTreeBody;
    const stub = new StubClient()
      .reply({})
      .reply({})
      .reply({})
      .reply({})
      .reply({})
      .reply({});
    const client = stub.asClient();

    await settings.getWebSettings(client);
    await settings.updateWebSettings(client, web);
    await settings.getMemoryGraphSettings(client);
    await settings.updateMemoryGraphSettings(client, memory);
    await settings.getIdeaTreeSettings(client);
    await settings.updateIdeaTreeSettings(client, idea);

    assert.equal(stub.calls[0]!.path, "/api/web/settings");
    assert.equal(stub.calls[1]!.path, "/api/web/settings");
    assert.deepEqual(json(stub.calls[1]!), web);
    assert.equal(stub.calls[2]!.path, "/api/memory/settings");
    assert.equal(stub.calls[3]!.path, "/api/memory/settings");
    assert.deepEqual(json(stub.calls[3]!), memory);
    assert.equal(stub.calls[4]!.path, "/api/settings/idea-tree");
    assert.equal(stub.calls[5]!.path, "/api/settings/idea-tree");
    assert.deepEqual(json(stub.calls[5]!), idea);
  });
});

describe("specialists", () => {
  it("creates, updates and deletes one specialist by id", async () => {
    const created = { name: "统计顾问" } as unknown as CreateSpecialistBody;
    const updated = { enabled: false } as unknown as UpdateSpecialistBody;
    const stub = new StubClient().reply([]).reply({}).reply({}).reply({});
    const client = stub.asClient();

    await settings.listSpecialists(client);
    await settings.createSpecialist(client, created);
    await settings.updateSpecialist(client, "specialist/one", updated);
    await settings.deleteSpecialist(client, "specialist/one");

    assert.equal(stub.calls[0]!.path, "/api/specialists");
    assert.equal(stub.calls[1]!.path, "/api/specialists");
    assert.equal(stub.calls[1]!.init.method, "POST");
    assert.deepEqual(json(stub.calls[1]!), created);
    assert.equal(stub.calls[2]!.path, "/api/specialists/specialist%2Fone");
    assert.equal(stub.calls[2]!.init.method, "PUT");
    assert.deepEqual(json(stub.calls[2]!), updated);
    assert.equal(stub.calls[3]!.path, "/api/specialists/specialist%2Fone");
    assert.equal(stub.calls[3]!.init.method, "DELETE");
  });
});

describe("failures", () => {
  it("does not turn a rejected write into an accepted one", async () => {
    const failure = new Error("permission epoch changed");
    const stub = new StubClient().fail(failure);

    await assert.rejects(
      () => settings.updateSandboxNetwork(stub.asClient(), {} as unknown as SandboxNetwork),
      (reason: unknown) => reason === failure,
    );
  });
});
