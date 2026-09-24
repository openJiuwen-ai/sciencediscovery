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
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { describe, test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

import { adapterServiceDefinition, jiuwenswarmPaths, jiuwenswarmServiceDefinition } from "./jiuwenswarm.js";
import type { PayloadManifest } from "./payload-manifest.js";

const baseManifest: PayloadManifest = {
  app: { apiEntry: "app/services/api/dist/server.js", root: "app", runnerEntry: "app/services/runner/dist/server.js", webDir: "app/apps/web/dist" },
  architecture: "x86_64",
  formatVersion: 2,
  node: { path: "node/bin/node", version: "v22.19.0" },
  product: "sciencediscovery",
  python: { path: "python/bin/python3", sitePackages: "python/lib/python3.12/site-packages", version: "3.12.13" },
  runtimeArchitecture: "x64",
  version: "0.0.0",
};

const withJiuwenswarm: PayloadManifest = {
  ...baseManifest,
  jiuwenswarm: { adapterSitePackages: "adapter/site-packages", sitePackages: "jiuwenswarm/site-packages", tag: "workswarm0.2.6" },
};

describe("jiuwenswarmPaths", () => {
  test("refuses a payload that was not built with JiuwenSwarm embedded", () => {
    assert.throws(
      () => jiuwenswarmPaths({
        manifest: baseManifest, payloadRoot: "/cache/payload/abc", dataDir: "/data",
        baseEnv: {}, pythonBinary: "/cache/payload/abc/python/bin/python3", log: () => {},
      }),
      /not built with JiuwenSwarm embedded/,
    );
  });

  test("resolves site-packages under the payload and HOME/data under the data dir, never the real $HOME", () => {
    const paths = jiuwenswarmPaths({
      manifest: withJiuwenswarm, payloadRoot: "/cache/payload/abc", dataDir: "/data",
      baseEnv: { HOME: "/root" }, pythonBinary: "/cache/payload/abc/python/bin/python3", log: () => {},
    });
    assert.equal(paths.sitePackages, "/cache/payload/abc/jiuwenswarm/site-packages");
    assert.equal(paths.adapterSitePackages, "/cache/payload/abc/adapter/site-packages");
    assert.equal(paths.home, "/data/jiuwenswarm-home");
    assert.equal(paths.dataDir, "/data/jiuwenswarm-data");
    assert.equal(paths.instanceWorkspace, "/data/jiuwenswarm-home/.jiuwenswarm-instances/sciencediscovery");
  });
});

describe("jiuwenswarmServiceDefinition", () => {
  test("runs the bundled interpreter with PYTHONPATH set to the embedded site-packages, never a console-script wrapper", () => {
    const paths = jiuwenswarmPaths({
      manifest: withJiuwenswarm, payloadRoot: "/cache/payload/abc", dataDir: "/data",
      baseEnv: {}, pythonBinary: "/cache/payload/abc/python/bin/python3", log: () => {},
    });
    const service = jiuwenswarmServiceDefinition(paths, {});
    assert.equal(service.command, "/cache/payload/abc/python/bin/python3");
    assert.ok(service.args[0] === "-c" && service.args[1]?.includes("jiuwenswarm.start_services"));
    assert.equal(
      service.env.PYTHONPATH,
      "/cache/payload/abc/adapter/site-packages/sciencediscovery_adapter:/cache/payload/abc/jiuwenswarm/site-packages",
    );
    assert.equal(service.env.SCIENCE_AGENT_JIUWENSWARM_BOOTSTRAP, "1");
    assert.equal(service.env.HOME, "/data/jiuwenswarm-home");
    assert.equal(service.env.JIUWENSWARM_DATA_DIR, "/data/jiuwenswarm-data");
    assert.equal(service.healthUrl, undefined, "its ports are not known until it reports them");
  });
});

describe("adapterServiceDefinition", () => {
  test("takes the public port, proxies to the API on the legacy port, and points at JiuwenSwarm's discovered ports", () => {
    const paths = jiuwenswarmPaths({
      manifest: withJiuwenswarm, payloadRoot: "/cache/payload/abc", dataDir: "/data",
      baseEnv: {}, pythonBinary: "/cache/payload/abc/python/bin/python3", log: () => {},
    });
    const service = adapterServiceDefinition(paths, {}, {
      publicPort: 4310, legacyPort: 4410, host: "127.0.0.1",
      endpoints: { gatewayPort: 20001, webPort: 20000 },
    });
    assert.deepEqual(service.args, ["-m", "sciencediscovery_adapter.server"]);
    assert.equal(service.env.PYTHONPATH, "/cache/payload/abc/adapter/site-packages");
    assert.equal(service.env.SCIENCE_AGENT_PORT, "4310");
    assert.equal(service.env.SCIENCE_AGENT_LEGACY_PORT, "4410");
    assert.equal(service.env.JIUWENSWARM_GATEWAY_URL, "ws://127.0.0.1:20001/tui");
    assert.equal(service.env.JIUWENSWARM_MGMT_URL, "ws://127.0.0.1:20000/ws");
    assert.equal(service.healthUrl, "http://127.0.0.1:4310/agent/info");
  });
});
