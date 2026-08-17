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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { PAYLOAD_MANIFEST_FILE } from "./payload-manifest.js";
import { payloadCacheRoot, resolvePayload } from "./payload-store.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("payload cache location", () => {
  test("uses the ScienceDiscovery cache root by default", () => {
    assert.equal(
      payloadCacheRoot({ HOME: "/home/operator" }),
      "/home/operator/.cache/science-discovery/payload",
    );
    assert.equal(
      payloadCacheRoot({ HOME: "/ignored", XDG_CACHE_HOME: "/srv/cache" }),
      "/srv/cache/science-discovery/payload",
    );
  });

  test("accepts the new override without compatibility output", () => {
    const messages: string[] = [];
    assert.equal(
      payloadCacheRoot(
        { SCIENCE_DISCOVERY_PAYLOAD_CACHE_DIR: "/srv/current" },
        (message) => messages.push(message),
      ),
      "/srv/current",
    );
    assert.deepEqual(messages, []);
  });

  test("logs legacy fallback and new-name precedence", () => {
    const fallbackMessages: string[] = [];
    assert.equal(
      payloadCacheRoot(
        { SCIENCE_AGENT_PAYLOAD_CACHE_DIR: "/srv/legacy" },
        (message) => fallbackMessages.push(message),
      ),
      "/srv/legacy",
    );
    assert.match(fallbackMessages[0] as string, /SCIENCE_AGENT_PAYLOAD_CACHE_DIR is deprecated/);

    const precedenceMessages: string[] = [];
    assert.equal(
      payloadCacheRoot(
        {
          SCIENCE_AGENT_PAYLOAD_CACHE_DIR: "/srv/legacy",
          SCIENCE_DISCOVERY_PAYLOAD_CACHE_DIR: "/srv/current",
        },
        (message) => precedenceMessages.push(message),
      ),
      "/srv/current",
    );
    assert.match(
      precedenceMessages[0] as string,
      /SCIENCE_DISCOVERY_PAYLOAD_CACHE_DIR takes precedence/,
    );
  });

  test("reads a pre-extracted payload through the legacy variable and logs it", async () => {
    const root = await mkdtemp(join(tmpdir(), "science-discovery-payload-"));
    temporaryRoots.push(root);
    await writeFile(
      join(root, PAYLOAD_MANIFEST_FILE),
      JSON.stringify({
        app: { apiEntry: "api.js" },
        architecture: "x86_64",
        formatVersion: 1,
        node: { path: "node" },
        python: { path: "python" },
        runtimeArchitecture: "x64",
        version: "1.0.0",
      }),
    );
    const messages: string[] = [];
    const payload = await resolvePayload({
      env: { SCIENCE_AGENT_PAYLOAD_DIR: root },
      onProgress: (message) => messages.push(message),
    });

    assert.equal(payload.root, root);
    assert.match(messages[0] as string, /SCIENCE_AGENT_PAYLOAD_DIR is deprecated/);
  });
});
