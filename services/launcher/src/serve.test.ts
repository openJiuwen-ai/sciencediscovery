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
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { ServeCredentials } from "./bootstrap-tokens.js";
import { defaultSettings } from "./cli-options.js";
import type { PayloadManifest } from "./payload-manifest.js";
import { planServices, seedProvisioner, type ServeContext, type ServicePlanContext } from "./serve.js";

const manifest: PayloadManifest = {
  app: {
    apiEntry: "app/services/api/dist/server.js",
    gatewayModule: "science_agent_gateway.server",
    root: "app",
    runnerEntry: "app/services/runner/dist/server.js",
    webDir: "app/apps/web/dist",
  },
  architecture: "x86_64",
  formatVersion: 1,
  micromamba: { path: "provisioner/micromamba", version: "2.8.1-0" },
  node: { path: "node/bin/node", version: "v22.19.0" },
  product: "science-agent",
  python: { path: "python/bin/python3", sitePackages: "python/lib/python3.12/site-packages", version: "3.12.13" },
  runtimeArchitecture: "x64",
  version: "0.0.0",
};

// Fixed stand-ins for what `serve` resolves from `<dataDir>/secrets`; the
// resolution chain itself is covered by bootstrap-tokens.test.ts, and keeping
// them literal here means planning a topology never touches the disk.
const credentials: ServeCredentials = {
  authToken: { source: "generated", token: "generated-access-token" },
  gatewayInternalToken: { source: "generated", token: "generated-gateway-token" },
};

function contextFor(overrides: Partial<ServicePlanContext> = {}): ServicePlanContext {
  return {
    baseEnv: {},
    credentials,
    manifest,
    payloadRoot: "/cache/payload/abc",
    settings: defaultSettings({}, "/opt/science-agent"),
    ...overrides,
  };
}

describe("serve topology", () => {
  test("starts gateway, then runner, then the API, each health gated", () => {
    const services = planServices(contextFor());
    assert.deepEqual(services.map((service) => service.name), [
      "agent-loop gateway",
      "bubblewrap runner",
      "control API and Web UI",
    ]);
    assert.deepEqual(services.map((service) => service.healthUrl), [
      "http://127.0.0.1:4312/health",
      "http://127.0.0.1:4311/health",
      "http://127.0.0.1:4310/health",
    ]);
  });

  test("runs every process from the payload, never from the host", () => {
    const services = planServices(contextFor());
    assert.deepEqual(
      services.map((service) => [service.command, ...service.args]),
      [
        ["/cache/payload/abc/python/bin/python3", "-m", "science_agent_gateway.server"],
        ["/cache/payload/abc/node/bin/node", "/cache/payload/abc/app/services/runner/dist/server.js"],
        ["/cache/payload/abc/node/bin/node", "/cache/payload/abc/app/services/api/dist/server.js"],
      ],
    );
    // repositoryRoot inside the API resolves four levels up from dist/http,
    // which must land on the payload's app root for the Web assets to load.
    assert.ok(services.every((service) => service.cwd === "/cache/payload/abc/app"));
  });

  test("a bootstrap-provisioned interpreter replaces the payload python for the gateway only", () => {
    const services = planServices(contextFor({ gatewayPythonPath: "/data/envs/gateway/bin/python" }));
    assert.deepEqual(
      services.map((service) => service.command),
      [
        "/data/envs/gateway/bin/python",
        "/cache/payload/abc/node/bin/node",
        "/cache/payload/abc/node/bin/node",
      ],
    );
  });

  test("does not rely on PYTHONPATH for the gateway's own package", () => {
    // The gateway starts stdio MCP servers through the MCP SDK, which forwards
    // only an allow-listed environment. PYTHONPATH would be dropped there, so
    // the payload installs into the interpreter's own site-packages instead.
    const [gateway] = planServices(contextFor());
    assert.equal(gateway?.env.PYTHONPATH, undefined);
  });

  test("preserves an operator-provided external URL config for the gateway and bootstrap probe", () => {
    const [gateway] = planServices(contextFor({
      baseEnv: { SCIENCE_AGENT_EXTERNAL_URLS_PATH: "/srv/science-agent/external-urls.json" },
    }));
    assert.equal(gateway?.cwd, "/cache/payload/abc/app");
    assert.equal(gateway?.env.SCIENCE_AGENT_EXTERNAL_URLS_PATH, "/srv/science-agent/external-urls.json");
  });

  test("keeps deer-flow harness state in the data directory", () => {
    // The gateway runs with its cwd inside the payload cache, so the harness
    // default of `.deer-flow/` beside the cwd would strand state there and lose
    // it the moment a new release unpacks to a different cache directory.
    const services = planServices(contextFor());
    for (const service of services) {
      assert.equal(service.env.DEER_FLOW_HOME, "/opt/science-agent/science-discovery-data/deer-flow");
    }
  });

  test("respects an operator-provided DEER_FLOW_HOME", () => {
    const [gateway] = planServices(contextFor({ baseEnv: { DEER_FLOW_HOME: "/srv/deer-flow" } }));
    assert.equal(gateway?.env.DEER_FLOW_HOME, "/srv/deer-flow");
  });

  test("shares one runner token between the runner and the API", () => {
    const [, runner, api] = planServices(contextFor());
    assert.equal(runner?.env.SCIENCE_AGENT_RUNNER_TOKEN, "science-agent-runner-local");
    assert.equal(api?.env.SCIENCE_AGENT_RUNNER_TOKEN, runner?.env.SCIENCE_AGENT_RUNNER_TOKEN);
    assert.equal(api?.env.SCIENCE_AGENT_RUNNER_URL, "http://127.0.0.1:4311");
    assert.equal(api?.env.SCIENCE_AGENT_GATEWAY_URL, "http://127.0.0.1:4312");
  });

  test("hands the same credentials to the API and the gateway", () => {
    const [gateway, , api] = planServices(contextFor());
    // Both ends of the internal channel must agree, and the API must receive the
    // access token `serve` prints, so no child regenerates one of its own.
    assert.equal(gateway?.env.SCIENCE_AGENT_GATEWAY_INTERNAL_TOKEN, "generated-gateway-token");
    assert.equal(api?.env.SCIENCE_AGENT_GATEWAY_INTERNAL_TOKEN, "generated-gateway-token");
    assert.equal(api?.env.SCIENCE_AGENT_AUTH_TOKEN, "generated-access-token");
  });

  test("passes an operator-configured token through unchanged", () => {
    const [gateway, , api] = planServices(contextFor({
      credentials: {
        authToken: { source: "environment", token: "chosen-access" },
        gatewayInternalToken: { source: "environment", token: "chosen-gateway" },
      },
    }));
    assert.equal(api?.env.SCIENCE_AGENT_AUTH_TOKEN, "chosen-access");
    assert.equal(gateway?.env.SCIENCE_AGENT_GATEWAY_INTERNAL_TOKEN, "chosen-gateway");
  });

  test("ships no fixed default credential in the process plan", () => {
    const plan = JSON.stringify(planServices(contextFor()));
    assert.ok(!plan.includes("science-agent-gateway-local"), "no fixed gateway token may remain");
    assert.ok(!plan.includes("science-agent-local"), "no fixed access token may remain");
  });

  test("forwards operator runner tuning and the bubblewrap path", () => {
    const context = contextFor({
      baseEnv: { SCIENCE_AGENT_EXEC_TIMEOUT_MS: "60000", SCIENCE_AGENT_SCIENTIFIC_CHANNELS: "conda-forge" },
    });
    context.settings.bwrapPath = "/usr/local/bin/bwrap";
    const [, runner] = planServices(context);
    assert.equal(runner?.env.SCIENCE_AGENT_EXEC_TIMEOUT_MS, "60000");
    assert.equal(runner?.env.SCIENCE_AGENT_SCIENTIFIC_CHANNELS, "conda-forge");
    assert.equal(runner?.env.SCIENCE_AGENT_BWRAP_PATH, "/usr/local/bin/bwrap");
  });

  test("disables scientific environments when the operator asked", () => {
    const context = contextFor();
    context.settings.scientificEnvironments = false;
    const [, runner] = planServices(context);
    assert.equal(runner?.env.SCIENTIFIC_ENVS, "0");
  });

  test("health checks a 0.0.0.0 bind over loopback", () => {
    const context = contextFor();
    context.settings.host = "0.0.0.0";
    const services = planServices(context);
    assert.equal(services[2]?.healthUrl, "http://127.0.0.1:4310/health");
  });

  test("never references Docker in the process plan", () => {
    const plan = JSON.stringify(planServices(contextFor({ baseEnv: {} })));
    assert.ok(!/docker/i.test(plan), "the binary serve path must not invoke Docker");
  });
});

describe("micromamba seeding", () => {
  let workspace = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "science-agent-seed-"));
  });

  after(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  async function payloadWithProvisioner(name: string): Promise<ServeContext> {
    const payloadRoot = join(workspace, name, "payload");
    const dataDir = join(workspace, name, "data");
    await rm(join(workspace, name), { force: true, recursive: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(payloadRoot, "provisioner"), { recursive: true });
    await writeFile(join(payloadRoot, "provisioner", "micromamba"), "#!/bin/sh\nexit 0\n");
    const context = contextFor({ payloadRoot });
    context.settings.dataDir = dataDir;
    return context;
  }

  test("seeds the runner's managed provisioner path and marks it executable", async () => {
    const context = await payloadWithProvisioner("seed");
    const seeded = await seedProvisioner(context);
    assert.equal(seeded, join(context.settings.dataDir, "scientific-envs", "bin", "micromamba"));
    await access(seeded as string, constants.X_OK);
  });

  test("leaves an existing provisioner in place", async () => {
    const context = await payloadWithProvisioner("existing");
    const target = await seedProvisioner(context) as string;
    await writeFile(target, "#!/bin/sh\necho operator copy\n");
    await seedProvisioner(context);
    assert.match(await readFile(target, "utf8"), /operator copy/);
  });

  test("defers to an administrator-configured provisioner", async () => {
    const context = await payloadWithProvisioner("configured");
    context.baseEnv = { SCIENCE_AGENT_PROVISIONER_PATH: "/opt/micromamba" };
    assert.equal(await seedProvisioner(context), undefined);
  });

  test("does not touch the data directory when scientific environments are off", async () => {
    const context = await payloadWithProvisioner("disabled");
    context.settings.scientificEnvironments = false;
    assert.equal(await seedProvisioner(context), undefined);
  });
});
