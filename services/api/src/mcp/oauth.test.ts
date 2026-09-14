// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMcpSourceRegistry } from "@sciencediscovery/mcp-sources";
import { CustomMcpServers, normalizeCustomMcpConfig } from "./custom-servers.js";
import { McpNodeClient } from "./node-client.js";
import { decryptSecretValue } from "../store/secrets.js";
import { MCP_OAUTH_CALLBACK } from "./oauth.js";

const fixturePath = new URL("../../../../test/fixtures/mcp-oauth.mjs", import.meta.url).href;
const { startOAuthFixture } = await import(fixturePath);
const redirectUrl = `http://127.0.0.1:4310${MCP_OAUTH_CALLBACK}`;

async function setup(transport = "http", registration = true) {
  const fixture = await startOAuthFixture({ transport, registration });
  const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-"));
  const manager = new CustomMcpServers(dir, createMcpSourceRegistry(), () => undefined, async () => undefined);
  await manager.load();
  const server = await manager.save({ name: "OAuth test", transport, url: fixture.mcpUrl, authMode: "oauth", enabled: true,
    ...(!registration ? { oauth: { clientId: "fixture-client", clientSecret: "fixture-client-secret" } } : {}) });
  const client = new McpNodeClient(() => {
    const config = manager.transportConfig();
    return { ...config, servers: { [server.id]: config.servers[server.id]! } };
  }, manager.oauth);
  const approve = async (deny = false) => {
    const started = await manager.oauth.begin(server.id, redirectUrl);
    const url = new URL(started.authorizationUrl); url.pathname = deny ? "/deny" : "/approve";
    const response = await fetch(url, { redirect: "manual" });
    assert.equal(response.status, 302);
    return new URL(response.headers.get("location")!);
  };
  const login = async () => {
    const callback = await approve();
    await manager.oauth.complete(callback.searchParams.get("state")!, callback.searchParams.get("code"), false);
    return callback;
  };
  return { fixture, dir, manager, server, client, approve, login, close: async () => { await client.close(); await fixture.close(); await rm(dir, { recursive: true, force: true }); } };
}

for (const transport of ["http", "sse"]) {
  test(`${transport} OAuth: real PKCE, encrypted persistence, tool discovery, 401 refresh and logout`, async () => {
    const f = await setup(transport);
    try {
      assert.equal(f.server.authorization?.state, "required");
      const unauthenticated = await f.client.catalog();
      assert.match(unauthenticated.servers[0]!.error!, /login required/);
      assert.equal(f.fixture.counts.registrations, 0, "Background discovery cannot start login");
      const callback = await f.login();
      assert.equal(f.fixture.counts.pkce, 1);
      await assert.rejects(f.manager.oauth.complete(callback.searchParams.get("state")!, callback.searchParams.get("code"), false), /state/);
      const catalog = await f.client.catalog();
      assert.equal(catalog.servers[0]!.tools[0]?.name, "echo", catalog.servers[0]!.error ?? "");
      const encrypted = await readFile(join(f.dir, "mcp-oauth.enc"), "utf8");
      assert.ok(!encrypted.includes("access_token"));
      const key = await readFile(join(f.dir, "model-secrets.key"));
      const saved = JSON.parse(decryptSecretValue(key, "mcp-oauth", encrypted));
      assert.ok(saved[f.server.id].tokens.refresh_token);
      assert.ok(!JSON.stringify(f.manager.list()).includes(saved[f.server.id].tokens.access_token));
      const restored = new CustomMcpServers(f.dir, createMcpSourceRegistry(), () => undefined, async () => undefined);
      await restored.load();
      assert.equal(restored.list()[0]!.authorization?.state, "authorized");
      f.fixture.expire();
      const again = await f.client.catalog();
      assert.equal(again.servers[0]!.tools.length, 1, again.servers[0]!.error ?? "");
      assert.equal(f.fixture.counts.refreshes, 1);
      await f.manager.oauth.clear(f.server.id);
      assert.equal(f.manager.list()[0]!.authorization?.state, "required");
      assert.match((await f.client.catalog()).servers[0]!.error!, /login required/);
      assert.ok(!JSON.stringify(JSON.parse(decryptSecretValue(key, "mcp-oauth", await readFile(join(f.dir, "mcp-oauth.enc"), "utf8")))).includes("access_token"));
    } finally { await f.close(); }
  });
}

test("OAuth static client, rotating refresh single-flight, expiry and revoked refresh feedback", async () => {
  const f = await setup("http", false);
  try {
    assert.equal(f.server.oauth?.clientSecret, null);
    f.fixture.setExpiresIn(1);
    await f.login();
    assert.equal(f.fixture.counts.registrations, 0);
    f.fixture.setExpiresIn(3600);
    await Promise.all(Array.from({ length: 12 }, () => f.manager.oauth.prepare(f.server.id)));
    assert.equal(f.fixture.counts.refreshes, 1);
    f.fixture.expire(); f.fixture.revokeRefresh();
    assert.match((await f.client.catalog()).servers[0]!.error!, /login required/);
    assert.equal(f.manager.oauth.status(f.server.id)?.state, "required");
    await f.login();
    assert.equal((await f.client.catalog()).servers[0]!.tools.length, 1);
  } finally { await f.close(); }
});

test("OAuth rejects missing/tampered/denied/cancelled state and config changes invalidate credentials", async () => {
  const f = await setup();
  try {
    await assert.rejects(f.manager.oauth.complete("unknown", "code", false), /state/);
    const denied = await f.approve(true);
    await assert.rejects(f.manager.oauth.complete(denied.searchParams.get("state")!, null, true), /denied/);
    const cancelled = await f.approve();
    f.manager.oauth.cancel(f.server.id);
    await assert.rejects(f.manager.oauth.complete(cancelled.searchParams.get("state")!, cancelled.searchParams.get("code"), false), /state/);
    await f.login();
    const details = f.manager.list()[0]!;
    await f.manager.save({ ...details, name: "Renamed" }, details.id);
    assert.equal(f.manager.oauth.status(details.id)?.state, "authorized");
    const oldFetch = f.manager.oauth.fetchFor(details.id)!;
    await f.manager.save({ ...details, url: `${f.fixture.origin}/changed` }, details.id);
    assert.equal(f.manager.oauth.status(details.id)?.state, "required");
    await assert.rejects(oldFetch(f.fixture.mcpUrl), /does not match/);
  } finally { await f.close(); }
});

test("OAuth cancellation during token exchange cannot restore cleared credentials", async () => {
  const f = await setup();
  let release!: () => void;
  try {
    f.fixture.setTokenDelay(new Promise<void>((resolve) => { release = resolve; }));
    const callback = await f.approve();
    const completion = f.manager.oauth.complete(callback.searchParams.get("state")!, callback.searchParams.get("code"), false);
    const rejected = assert.rejects(completion, /failed/);
    const deadline = Date.now() + 3000;
    while (!f.fixture.counts.exchanges && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.fixture.counts.exchanges, 1);
    await f.manager.oauth.clear(f.server.id);
    release();
    await rejected;
    assert.equal(f.manager.oauth.status(f.server.id)?.state, "required");
    await assert.rejects(f.manager.oauth.prepare(f.server.id), /login required/);
  } finally { release?.(); await f.close(); }
});

test("OAuth scope step-up prompts consent, and bearer credentials cannot cross origins", async () => {
  const f = await setup();
  try {
    await f.login();
    await assert.rejects(f.manager.oauth.fetchFor(f.server.id)!("https://example.com/mcp"), /does not match/);
    f.fixture.setStepUp(true);
    assert.match((await f.client.catalog()).servers[0]!.error!, /login required/);
    const started = await f.manager.oauth.begin(f.server.id, redirectUrl);
    assert.equal(new URL(started.authorizationUrl).searchParams.get("scope"), "tools:write");
  } finally { await f.close(); }
});

test("OAuth rejects insecure remote endpoints and conflicting Authorization headers", () => {
  assert.throws(() => normalizeCustomMcpConfig({ name: "x", url: "http://example.com/mcp", authMode: "oauth" }), /HTTPS/);
  assert.throws(() => normalizeCustomMcpConfig({ name: "x", url: "https://example.com/mcp", authMode: "oauth", headers: { authorization: "Bearer x" } }), /Remove/);
  assert.throws(() => normalizeCustomMcpConfig({ name: "x", url: "https://example.com/mcp", authMode: "oauth", oauth: { clientSecret: "x" } }), /Client ID/);
});
