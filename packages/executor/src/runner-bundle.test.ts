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
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { packRunnerBundle, RUNNER_BUNDLE_ENTRY } from "./runner-bundle.js";

/** Entry paths of a ustar archive, read the way the remote `tar` reads them. */
function tarEntries(archive: Buffer): Array<{ path: string; size: number }> {
  const entries: Array<{ path: string; size: number }> = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) break;
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8);
    entries.push({ path: prefix ? `${prefix}/${name}` : name, size });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("the deployable runner bundle carries the runner and every workspace package it imports", async () => {
  const bundle = await packRunnerBundle();
  const entries = tarEntries(gunzipSync(bundle.archive));
  const paths = new Set(entries.map((entry) => entry.path));

  assert.ok(paths.has(RUNNER_BUNDLE_ENTRY), `bundle is missing ${RUNNER_BUNDLE_ENTRY}`);
  // The runner imports these three at runtime, and the schema package reads the
  // external URL configuration that sits beside its manifest.
  for (const packageName of ["schema", "operational-logging", "sandbox-capability", "external-urls"]) {
    assert.ok(
      paths.has(`node_modules/@sciencediscovery/${packageName}/package.json`),
      `bundle is missing the ${packageName} manifest`,
    );
  }
  assert.ok(paths.has("services/runner/package.json"));
  // The runner reads its NPU workload catalogue from a repository-relative
  // path, so the deployed tree keeps the runner where that path still lands.
  assert.ok(paths.has("services/runner/workloads/npu-workloads.default.json"));
  assert.ok(paths.has("node_modules/@sciencediscovery/external-urls/external-urls.json"));
  // Test files and type declarations would double the transfer without ever
  // being loaded by a running runner.
  assert.equal(entries.some((entry) => /\.test\.js$|\.d\.ts$|\.map$/.test(entry.path)), false);
  assert.ok(bundle.uncompressedBytes > 0);
  assert.match(bundle.id, /^[a-f0-9]{64}$/);
});

test("packing twice produces the same archive so an unchanged host is left alone", async () => {
  const [first, second] = await Promise.all([packRunnerBundle(), packRunnerBundle()]);
  assert.equal(first.id, second.id);
  assert.deepEqual(first.archive, second.archive);
});
