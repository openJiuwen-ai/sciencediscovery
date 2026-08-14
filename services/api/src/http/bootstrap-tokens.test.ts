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
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";

import {
  accessTokenBanner,
  AUTH_TOKEN_FILE,
  bootstrapTokenPath,
  GATEWAY_INTERNAL_TOKEN_FILE,
  resolveBootstrapToken,
} from "./bootstrap-tokens.js";
import { loadServerConfig } from "./config.js";

async function temporaryDataDir(context: TestContext, name: string): Promise<string> {
  const dataDir = resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  return dataDir;
}

test("a first start generates a high-entropy token and persists it privately", async (context) => {
  const dataDir = await temporaryDataDir(context, "bootstrap-first");

  const resolved = resolveBootstrapToken(dataDir, AUTH_TOKEN_FILE);

  assert.equal(resolved.source, "generated");
  // 32 random bytes in base64url; anything short would be a weak credential.
  assert.equal(resolved.token.length, 43);
  assert.match(resolved.token, /^[A-Za-z0-9_-]+$/);
  const path = bootstrapTokenPath(dataDir, AUTH_TOKEN_FILE);
  assert.equal((await readFile(path, "utf8")).trim(), resolved.token);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("two installations never share a token", async (context) => {
  const first = await temporaryDataDir(context, "bootstrap-entropy-a");
  const second = await temporaryDataDir(context, "bootstrap-entropy-b");

  assert.notEqual(
    resolveBootstrapToken(first, AUTH_TOKEN_FILE).token,
    resolveBootstrapToken(second, AUTH_TOKEN_FILE).token,
  );
});

test("a restart reuses the stored token instead of generating another", async (context) => {
  const dataDir = await temporaryDataDir(context, "bootstrap-restart");
  const first = resolveBootstrapToken(dataDir, AUTH_TOKEN_FILE);

  const second = resolveBootstrapToken(dataDir, AUTH_TOKEN_FILE);

  assert.equal(second.source, "stored");
  assert.equal(second.token, first.token);
});

test("each credential is stored separately", async (context) => {
  const dataDir = await temporaryDataDir(context, "bootstrap-separate");

  const auth = resolveBootstrapToken(dataDir, AUTH_TOKEN_FILE);
  const gateway = resolveBootstrapToken(dataDir, GATEWAY_INTERNAL_TOKEN_FILE);

  assert.notEqual(auth.token, gateway.token);
  assert.equal(
    (await readFile(bootstrapTokenPath(dataDir, GATEWAY_INTERNAL_TOKEN_FILE), "utf8")).trim(),
    gateway.token,
  );
});

test("an explicit token wins and is never written to disk", async (context) => {
  const dataDir = await temporaryDataDir(context, "bootstrap-explicit");

  const resolved = resolveBootstrapToken(dataDir, AUTH_TOKEN_FILE, "  operator-token  ");

  assert.deepEqual(resolved, { source: "environment", token: "operator-token" });
  await assert.rejects(stat(bootstrapTokenPath(dataDir, AUTH_TOKEN_FILE)), /ENOENT/);
});

test("an explicit token overrides a token already stored", async (context) => {
  const dataDir = await temporaryDataDir(context, "bootstrap-override");
  const stored = resolveBootstrapToken(dataDir, AUTH_TOKEN_FILE).token;

  const resolved = resolveBootstrapToken(dataDir, AUTH_TOKEN_FILE, "operator-token");

  assert.equal(resolved.token, "operator-token");
  // The stored value survives untouched, so unsetting the variable restores it.
  assert.equal((await readFile(bootstrapTokenPath(dataDir, AUTH_TOKEN_FILE), "utf8")).trim(), stored);
});

test("a blank stored token is replaced rather than used as a credential", async (context) => {
  const dataDir = await temporaryDataDir(context, "bootstrap-blank");
  const path = bootstrapTokenPath(dataDir, AUTH_TOKEN_FILE);
  await mkdir(resolve(dataDir, "secrets"), { recursive: true });
  await writeFile(path, "   \n");

  const resolved = resolveBootstrapToken(dataDir, AUTH_TOKEN_FILE);

  assert.equal(resolved.source, "generated");
  assert.equal(resolved.token.length, 43);
  assert.equal((await readFile(path, "utf8")).trim(), resolved.token);
});

test("the server configuration carries no fixed default credential", async (context) => {
  const dataDir = await temporaryDataDir(context, "bootstrap-config");

  const config = loadServerConfig({ SCIENCE_AGENT_DATA_DIR: dataDir });

  assert.notEqual(config.authToken, "science-agent-local");
  assert.notEqual(config.gatewayInternalToken, "science-agent-gateway-local");
  assert.equal(config.authTokenSource, "generated");
  assert.equal(config.gatewayInternalTokenSource, "generated");
  // A second load is the "restart" case: same values, marked as restored.
  const restarted = loadServerConfig({ SCIENCE_AGENT_DATA_DIR: dataDir });
  assert.equal(restarted.authToken, config.authToken);
  assert.equal(restarted.gatewayInternalToken, config.gatewayInternalToken);
  assert.equal(restarted.authTokenSource, "stored");
});

test("explicit environment tokens keep their existing meaning", async (context) => {
  const dataDir = await temporaryDataDir(context, "bootstrap-config-env");

  const config = loadServerConfig({
    SCIENCE_AGENT_AUTH_TOKEN: "my-auth-token",
    SCIENCE_AGENT_DATA_DIR: dataDir,
    SCIENCE_AGENT_GATEWAY_INTERNAL_TOKEN: "my-gateway-token",
  });

  assert.equal(config.authToken, "my-auth-token");
  assert.equal(config.gatewayInternalToken, "my-gateway-token");
  assert.equal(config.authTokenSource, "environment");
  await assert.rejects(stat(bootstrapTokenPath(dataDir, AUTH_TOKEN_FILE)), /ENOENT/);
});

test("startup output shows a managed token and hides an operator-supplied one", async (context) => {
  const dataDir = await temporaryDataDir(context, "bootstrap-banner");
  const managed = loadServerConfig({ SCIENCE_AGENT_DATA_DIR: dataDir });

  const shown = accessTokenBanner(managed).join("\n");
  const hidden = accessTokenBanner(loadServerConfig({
    SCIENCE_AGENT_AUTH_TOKEN: "operator-token",
    SCIENCE_AGENT_DATA_DIR: dataDir,
  })).join("\n");

  assert.equal(shown.includes(managed.authToken), true);
  assert.match(shown, /generated on first start/);
  assert.equal(shown.includes(bootstrapTokenPath(dataDir, AUTH_TOKEN_FILE)), true);
  assert.equal(hidden.includes("operator-token"), false);
  assert.match(hidden, /SCIENCE_AGENT_AUTH_TOKEN/);
});
