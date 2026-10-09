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
const { after, before, describe, test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";


import {
  accessTokenBanner,
  AUTH_TOKEN_FILE,
  bootstrapTokenPath,
  resolveBootstrapToken,
  resolveServeCredentials,
} from "./bootstrap-tokens.js";

describe("launcher bootstrap credentials", () => {
  let workspace: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "sciencediscovery-launcher-tokens-"));
  });

  after(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  test("generates and stores a token on the first serve", async () => {
    const dataDir = join(workspace, "first");

    const resolved = resolveBootstrapToken(dataDir, AUTH_TOKEN_FILE);

    assert.equal(resolved.source, "generated");
    assert.equal(resolved.token.length, 43);
    const path = bootstrapTokenPath(dataDir, AUTH_TOKEN_FILE);
    assert.equal((await readFile(path, "utf8")).trim(), resolved.token);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  test("reuses the stored token on the next serve", () => {
    const dataDir = join(workspace, "restart");
    const first = resolveBootstrapToken(dataDir, AUTH_TOKEN_FILE);

    const second = resolveBootstrapToken(dataDir, AUTH_TOKEN_FILE);

    assert.equal(second.source, "stored");
    assert.equal(second.token, first.token);
  });

  test("an operator token wins and leaves no file behind", async () => {
    const dataDir = join(workspace, "explicit");

    const credentials = resolveServeCredentials(dataDir, {
      SCIENCE_AGENT_AUTH_TOKEN: " chosen-token ",
    });

    assert.deepEqual(credentials.authToken, { source: "environment", token: "chosen-token" });
    await assert.rejects(stat(bootstrapTokenPath(dataDir, AUTH_TOKEN_FILE)), /ENOENT/);
    // The retired gateway service's internal token is no longer generated, so
    // an install started fresh writes nothing beside the access token.
    await assert.rejects(stat(bootstrapTokenPath(dataDir, "gateway-internal-token")), /ENOENT/);
  });

  test("no fixed default survives anywhere in the chain", () => {
    const credentials = resolveServeCredentials(join(workspace, "no-default"), {});

    assert.notEqual(credentials.authToken.token, "science-agent-local");
  });

  for (const source of ["generated", "stored", "environment"] as const) {
    test(`the ready banner opens a sign-in URL for a ${source} token`, () => {
      const dataDir = join(workspace, "banner");
      const token = "local+token/with?reserved=&字符";
      const shown = accessTokenBanner(dataDir, { authToken: { source, token } }, "http://127.0.0.1:54321");
      const url = new URL(shown[0]!.trim().replace("Open to sign in: ", ""));
      assert.equal(url.origin, "http://127.0.0.1:54321");
      assert.equal(url.search, "");
      assert.equal(new URLSearchParams(url.hash.slice(1)).get("token"), token);
      assert.match(shown.join("\n"), /Local service access token/);
      assert.equal(shown.join("\n").includes(bootstrapTokenPath(dataDir, AUTH_TOKEN_FILE)), source !== "environment");
    });
  }
});
