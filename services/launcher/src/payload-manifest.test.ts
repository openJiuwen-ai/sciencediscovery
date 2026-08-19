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
import { describe, test } from "node:test";

import { parsePayloadManifest } from "./payload-manifest.js";

const base = {
  app: {
    apiEntry: "app/services/api/dist/server.js",
    root: "app",
    runnerEntry: "app/services/runner/dist/server.js",
    webDir: "app/apps/web/dist",
  },
  architecture: "x86_64",
  node: { path: "node/bin/node", version: "v22.19.0" },
  product: "science-agent",
  python: { path: "python/bin/python3", sitePackages: "python/lib/python3.12/site-packages", version: "3.12.13" },
  runtimeArchitecture: "x64",
  version: "1.2.3",
};

const bootstrap = {
  gatewayWheelPath: "bootstrap/wheels/science_agent_gateway-0.0.0-py3-none-any.whl",
  requirementsPath: "bootstrap/requirements-gateway.txt",
  uv: { project: "uv", version: "0.9.26", wheelFilename: "uv-0.9.26.whl", wheelSha256: "b".repeat(64) },
};

describe("payload manifest parsing", () => {
  test("still accepts a version-1 payload with embedded dependencies", () => {
    const manifest = parsePayloadManifest(JSON.stringify({ ...base, formatVersion: 1 }), "manifest.json");
    assert.equal(manifest.formatVersion, 1);
    assert.equal(manifest.bootstrap, undefined);
  });

  test("accepts a version-2 payload with a complete bootstrap section", () => {
    const manifest = parsePayloadManifest(JSON.stringify({ ...base, bootstrap, formatVersion: 2 }), "manifest.json");
    assert.equal(manifest.bootstrap?.uv.version, "0.9.26");
    assert.equal(manifest.bootstrap?.gatewayWheelPath, bootstrap.gatewayWheelPath);
  });

  test("rejects a version-2 payload whose bootstrap pins are incomplete", () => {
    assert.throws(
      () => parsePayloadManifest(JSON.stringify({ ...base, formatVersion: 2 }), "manifest.json"),
      /bootstrap uv wheel pin/,
    );
    const missingArtifacts = { ...bootstrap, gatewayWheelPath: "" };
    assert.throws(
      () => parsePayloadManifest(JSON.stringify({ ...base, bootstrap: missingArtifacts, formatVersion: 2 }), "manifest.json"),
      /bootstrap artifact path entry/,
    );
  });

  test("ignores the retired deer-flow pin an older release recorded", () => {
    // Payloads built before the vendor was dropped still carry the field; a
    // launcher upgrade must keep loading an already-extracted payload dir.
    const legacy = { ...bootstrap, deerFlow: { commit: "a".repeat(40), harnessPath: "x", treeDigest: "sha256:y" } };
    const manifest = parsePayloadManifest(JSON.stringify({ ...base, bootstrap: legacy, formatVersion: 2 }), "manifest.json");
    assert.equal(manifest.bootstrap?.uv.version, "0.9.26");
  });

  test("rejects unknown format versions", () => {
    assert.throws(
      () => parsePayloadManifest(JSON.stringify({ ...base, formatVersion: 3 }), "manifest.json"),
      /understands versions 1, 2/,
    );
  });
});
