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
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  accessTokenBanner,
  AUTH_TOKEN_FILE,
  bootstrapTokenPath,
  GATEWAY_INTERNAL_TOKEN_FILE,
  resolveBootstrapToken,
  resolveServeCredentials,
} from "./bootstrap-tokens.js";

describe("launcher bootstrap credentials", () => {
  let workspace: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "science-agent-launcher-tokens-"));
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
    // The gateway credential is independent: it is still generated here.
    assert.equal(credentials.gatewayInternalToken.source, "generated");
    await stat(bootstrapTokenPath(dataDir, GATEWAY_INTERNAL_TOKEN_FILE));
  });

  test("no fixed default survives anywhere in the chain", () => {
    const credentials = resolveServeCredentials(join(workspace, "no-default"), {});

    assert.notEqual(credentials.authToken.token, "science-agent-local");
    assert.notEqual(credentials.gatewayInternalToken.token, "science-agent-gateway-local");
    assert.notEqual(credentials.authToken.token, credentials.gatewayInternalToken.token);
  });

  test("the ready banner prints a managed token and withholds an operator one", () => {
    const dataDir = join(workspace, "banner");
    const managed = resolveServeCredentials(dataDir, {});

    const shown = accessTokenBanner(dataDir, managed).join("\n");
    const hidden = accessTokenBanner(
      dataDir,
      resolveServeCredentials(dataDir, { SCIENCE_AGENT_AUTH_TOKEN: "operator-token" }),
    ).join("\n");

    assert.equal(shown.includes(managed.authToken.token), true);
    assert.equal(shown.includes(bootstrapTokenPath(dataDir, AUTH_TOKEN_FILE)), true);
    assert.equal(hidden.includes("operator-token"), false);
    assert.match(hidden, /SCIENCE_AGENT_AUTH_TOKEN/);
  });
});
