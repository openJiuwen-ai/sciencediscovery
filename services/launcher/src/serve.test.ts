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
import { mcpProbeRuntime, planServices, seedProvisioner, type ServeContext, type ServicePlanContext } from "./serve.js";

const manifest: PayloadManifest = {
  app: {
    apiEntry: "app/services/api/dist/server.js",
    root: "app",
    runnerEntry: "app/services/runner/dist/server.js",
    webDir: "app/apps/web/dist",
  },
  architecture: "x86_64",
  formatVersion: 1,
  micromamba: { path: "provisioner/micromamba", version: "2.8.1-0" },
  node: { path: "node/bin/node", version: "v22.19.0" },
  product: "sciencediscovery",
  python: { path: "python/bin/python3", sitePackages: "python/lib/python3.12/site-packages", version: "3.12.13" },
  runtimeArchitecture: "x64",
  version: "0.0.0",
};

// Fixed stand-ins for what `serve` resolves from `<dataDir>/secrets`; the
// resolution chain itself is covered by bootstrap-tokens.test.ts, and keeping
// them literal here means planning a topology never touches the disk.
const credentials: ServeCredentials = {
  authToken: { source: "generated", token: "generated-access-token" },
};

function contextFor(overrides: Partial<ServicePlanContext> = {}): ServicePlanContext {
  return {
    baseEnv: {},
    credentials,
    manifest,
    payloadRoot: "/cache/payload/abc",
    settings: defaultSettings({}, "/opt/sciencediscovery"),
    ...overrides,
  };
}

describe("serve topology", () => {
  test("starts the runner, then the API, each health gated — no Python service", () => {
    const services = planServices(contextFor());
    // The agent loop, the MCP client and the web providers all run inside the
    // API process. Supervising a Python service here would gate startup on a
    // health endpoint nothing serves.
    assert.deepEqual(services.map((service) => service.name), [
      "bubblewrap runner",
      "control API and Web UI",
    ]);
    assert.deepEqual(services.map((service) => service.healthUrl), [
      "http://127.0.0.1:4311/health",
      "http://127.0.0.1:4310/health",
    ]);
    assert.ok(
      services.every((service) => !service.command.includes("python")),
      "no supervised service may be a Python process",
    );
  });

  test("runs every process from the payload, never from the host", () => {
    const services = planServices(contextFor());
    assert.deepEqual(
      services.map((service) => [service.command, ...service.args]),
      [
        ["/cache/payload/abc/node/bin/node", "/cache/payload/abc/app/services/runner/dist/server.js"],
        ["/cache/payload/abc/node/bin/node", "/cache/payload/abc/app/services/api/dist/server.js"],
      ],
    );
    // repositoryRoot inside the API resolves four levels up from dist/http,
    // which must land on the payload's app root for the Web assets to load.
    assert.ok(services.every((service) => service.cwd === "/cache/payload/abc/app"));
  });

  test("the API is told which interpreter starts the bundled stdio MCP servers", () => {
    // `resolveMcpPython()` otherwise searches repository-shaped paths relative
    // to the process cwd, which here is inside the payload cache.
    const [, embedded] = planServices(contextFor());
    assert.equal(embedded?.env.SCIENCE_AGENT_GATEWAY_PYTHON_PATH, "/cache/payload/abc/python/bin/python3");

    const [, provisioned] = planServices(contextFor({ gatewayPythonPath: "/data/envs/gateway/bin/python" }));
    assert.equal(provisioned?.env.SCIENCE_AGENT_GATEWAY_PYTHON_PATH, "/data/envs/gateway/bin/python");
    // The interpreter is a spawn target, not a supervised process.
    assert.deepEqual(
      planServices(contextFor({ gatewayPythonPath: "/data/envs/gateway/bin/python" })).map((s) => s.command),
      ["/cache/payload/abc/node/bin/node", "/cache/payload/abc/node/bin/node"],
    );
  });

  test("does not rely on PYTHONPATH for the bundled MCP servers' package", () => {
    // The API starts those servers through the MCP SDK, which forwards only an
    // allow-listed environment. PYTHONPATH would be dropped there, so the
    // payload installs into the interpreter's own site-packages instead.
    for (const service of planServices(contextFor())) {
      assert.equal(service.env.PYTHONPATH, undefined);
    }
  });

  test("the bootstrap probe runs in the app root and keeps an operator URL config", () => {
    const runtime = mcpProbeRuntime(contextFor({
      baseEnv: { SCIENCE_AGENT_EXTERNAL_URLS_PATH: "/srv/science-agent/external-urls.json" },
    }));
    assert.equal(runtime.cwd, "/cache/payload/abc/app");
    assert.equal(runtime.env.SCIENCE_AGENT_EXTERNAL_URLS_PATH, "/srv/science-agent/external-urls.json");
  });

  test("no service carries the retired vendor state directory", () => {
    // DEER_FLOW_HOME only existed to keep the vendor harness from writing
    // `.deer-flow/` into the payload cache. The harness is gone, so injecting
    // it would create an empty directory nothing reads.
    for (const service of planServices(contextFor())) {
      assert.equal(service.env.DEER_FLOW_HOME, undefined);
    }
  });

  test("shares one runner token between the runner and the API", () => {
    const [runner, api] = planServices(contextFor());
    assert.equal(runner?.env.SCIENCE_AGENT_RUNNER_TOKEN, "sciencediscovery-runner-local");
    assert.equal(api?.env.SCIENCE_AGENT_RUNNER_TOKEN, runner?.env.SCIENCE_AGENT_RUNNER_TOKEN);
    assert.equal(api?.env.SCIENCE_AGENT_RUNNER_URL, "http://127.0.0.1:4311");
  });

  test("no service is pointed at the retired gateway HTTP endpoint", () => {
    // The API drives the loop itself; handing it a URL and an internal token
    // for a service nobody starts would only invite one to be started again.
    for (const service of planServices(contextFor())) {
      assert.equal(service.env.SCIENCE_AGENT_GATEWAY_URL, undefined);
      assert.equal(service.env.SCIENCE_AGENT_GATEWAY_INTERNAL_TOKEN, undefined);
      assert.equal(service.env.SCIENCE_AGENT_GATEWAY_PORT, undefined);
    }
  });

  test("hands the printed access token to the API", () => {
    const [, api] = planServices(contextFor());
    // The API must receive the token `serve` prints, so it never generates one
    // of its own that the user was never shown.
    assert.equal(api?.env.SCIENCE_AGENT_AUTH_TOKEN, "generated-access-token");
  });

  test("passes an operator-configured token through unchanged", () => {
    const [, api] = planServices(contextFor({
      credentials: { authToken: { source: "environment", token: "chosen-access" } },
    }));
    assert.equal(api?.env.SCIENCE_AGENT_AUTH_TOKEN, "chosen-access");
  });

  test("ships no fixed default credential in the process plan", () => {
    const plan = JSON.stringify(planServices(contextFor()));
    assert.ok(!plan.includes("science-agent-local"), "no fixed access token may remain");
  });

  test("forwards operator runner tuning and the bubblewrap path", () => {
    const context = contextFor({
      baseEnv: { SCIENCE_AGENT_EXEC_TIMEOUT_MS: "60000", SCIENCE_AGENT_SCIENTIFIC_CHANNELS: "conda-forge" },
    });
    context.settings.bwrapPath = "/usr/local/bin/bwrap";
    const [runner] = planServices(context);
    assert.equal(runner?.env.SCIENCE_AGENT_EXEC_TIMEOUT_MS, "60000");
    assert.equal(runner?.env.SCIENCE_AGENT_SCIENTIFIC_CHANNELS, "conda-forge");
    assert.equal(runner?.env.SCIENCE_AGENT_BWRAP_PATH, "/usr/local/bin/bwrap");
  });

  test("disables scientific environments when the operator asked", () => {
    const context = contextFor();
    context.settings.scientificEnvironments = false;
    const [runner] = planServices(context);
    assert.equal(runner?.env.SCIENTIFIC_ENVS, "0");
  });

  test("health checks a 0.0.0.0 bind over loopback", () => {
    const context = contextFor();
    context.settings.host = "0.0.0.0";
    const services = planServices(context);
    assert.equal(services.at(-1)?.healthUrl, "http://127.0.0.1:4310/health");
  });

  test("never references Docker in the process plan", () => {
    const plan = JSON.stringify(planServices(contextFor({ baseEnv: {} })));
    assert.ok(!/docker/i.test(plan), "the binary serve path must not invoke Docker");
  });
});

describe("micromamba seeding", () => {
  let workspace = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "sciencediscovery-seed-"));
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
