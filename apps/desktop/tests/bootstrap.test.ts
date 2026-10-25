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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { ApiClient } from "../src/api/client.js";
import { setGlobalModel } from "../src/api/models.js";
import type { GlobalSettings, ModelProfile } from "../src/api/types.js";
import { resolveCatalog, resolveConnection } from "../src/app/bootstrap.js";
import { loadLocalAccessToken } from "../src/local-access-token.js";
import { TOKEN_STORAGE_KEY, readRenamedStorageItem, readStoredFlag } from "../src/state/storage.js";

function profile(id: string): ModelProfile {
  return {
    baseUrl: "https://api.example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    hasApiToken: true,
    id,
    model: "gpt-4o-mini",
    name: id,
    proxyPolicy: "inherit",
    updatedAt: "2026-01-01T00:00:00.000Z",
    vision: false,
  } as ModelProfile;
}

function settings(overrides: Record<string, unknown>): GlobalSettings {
  return {
    effective: {} as GlobalSettings["effective"],
    overrides: overrides as GlobalSettings["overrides"],
    sources: {},
  };
}

test("an empty catalog is the first-run condition, not an empty workspace", () => {
  assert.deepEqual(resolveCatalog([], {}), { boot: "setup" });
  assert.deepEqual(resolveCatalog([], { modelId: "ghost" }), { boot: "setup" });
});

test("an existing global selection is kept and never rewritten", () => {
  const decision = resolveCatalog([profile("a"), profile("b")], { modelId: "b" });
  assert.equal(decision.boot, "ready");
  assert.equal(decision.defaultModelId, "b");
  // No `adopt`: rewriting the settings object here would be a write that can
  // only lose information.
  assert.equal(decision.adopt, undefined);
});

test("no selection adopts the first profile", () => {
  const decision = resolveCatalog([profile("a"), profile("b")], {});
  assert.equal(decision.defaultModelId, "a");
  assert.equal(decision.adopt, "a");
});

test("a selection naming a deleted profile is replaced, not trusted", () => {
  // `PUT /api/settings` normalizes through the live catalog and drops an
  // unknown modelId, so keeping "gone" would leave a default that never exists.
  const decision = resolveCatalog([profile("a")], { modelId: "gone" });
  assert.equal(decision.defaultModelId, "a");
  assert.equal(decision.adopt, "a");
});

test("a service that reports a subsystem off is degraded, not offline", () => {
  assert.equal(resolveConnection({ service: "api", status: "ok" }), "online");
  assert.equal(resolveConnection({ memoryGraph: "degraded", status: "ok" }), "degraded");
  assert.equal(resolveConnection({ status: "degraded" }), "degraded");
  // Health answers before the token gate, so a body-less 200 is still "up".
  assert.equal(resolveConnection({}), "degraded");
});

test("setting the default reads the current settings and sends them back whole", async () => {
  const calls: { init: RequestInit; path: string }[] = [];
  const existing = { connectorIds: ["c1"], modelId: "old", skillIds: ["s1"] };
  const client = {
    async request(path: string, init: RequestInit = {}) {
      calls.push({ init, path });
      if (init.method !== "PUT") return settings(existing);
      return settings(JSON.parse(String(init.body)) as Record<string, unknown>);
    },
  } as unknown as ApiClient;

  const result = await setGlobalModel(client, "new");

  assert.deepEqual(
    calls.map((call) => `${call.init.method ?? "GET"} ${call.path}`),
    ["GET /api/settings", "PUT /api/settings"],
  );
  // `PUT /api/settings` is a whole-object write. Sending `{modelId}` alone
  // would erase the connector and skill selections this app never shows.
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), {
    connectorIds: ["c1"],
    modelId: "new",
    skillIds: ["s1"],
  });
  assert.equal(result.overrides.modelId, "new");
});

test("a dropped modelId comes back dropped, so the caller cannot claim success", async () => {
  const client = {
    async request(_path: string, init: RequestInit = {}) {
      if (init.method !== "PUT") return settings({});
      return settings({});
    },
  } as unknown as ApiClient;
  const result = await setGlobalModel(client, "ghost");
  assert.equal(result.overrides.modelId, undefined);
});

test("the token comes from the URL fragment and then leaves the address bar", () => {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
  const replaced: string[] = [];
  const token = loadLocalAccessToken(
    storage,
    { href: "http://127.0.0.1:4310/#token=abc123" },
    { replaceState: (_state, _title, url) => void replaced.push(String(url)), state: null },
  );

  assert.equal(token, "abc123");
  assert.equal(stored.get(TOKEN_STORAGE_KEY), "abc123");
  // The fragment must not stay in the address bar: it is a credential, and a
  // copied URL would carry it.
  assert.deepEqual(replaced, ["/"]);
});

test("a second read finds the stored token, because the fragment is already consumed", () => {
  const stored = new Map<string, string>([[TOKEN_STORAGE_KEY, "abc123"]]);
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
  const token = loadLocalAccessToken(
    storage,
    { href: "http://127.0.0.1:4310/" },
    { replaceState: () => undefined, state: null },
  );
  assert.equal(token, "abc123");
});

test("the pre-rename token key is imported once instead of losing the session", () => {
  const stored = new Map<string, string>([["science-agent-token", "legacy"]]);
  const removed: string[] = [];
  let reads = 0;
  const storage = {
    getItem: (key: string) => {
      reads += 1;
      return stored.get(key) ?? null;
    },
    removeItem: (key: string) => void removed.push(key),
    setItem: (key: string, value: string) => void stored.set(key, value),
  };

  assert.equal(readRenamedStorageItem(storage, TOKEN_STORAGE_KEY), "legacy");
  assert.equal(stored.get(TOKEN_STORAGE_KEY), "legacy");
  assert.deepEqual(removed, ["science-agent-token"]);
  // Only the first read has to look at the old key.
  const afterImport = reads;
  assert.equal(readRenamedStorageItem(storage, TOKEN_STORAGE_KEY), "legacy");
  assert.equal(reads, afterImport + 1);
});

test("a storage that throws degrades to no preference, never to a crash", () => {
  const hostile = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("quota");
    },
  };
  assert.equal(readStoredFlag(hostile, "any-key"), false);
  assert.equal(readRenamedStorageItem(hostile, TOKEN_STORAGE_KEY), null);
});

test("the right-panel preference is a stored flag, not a default-on", () => {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
  assert.equal(readStoredFlag(storage, "panel"), false);
  stored.set("panel", "1");
  assert.equal(readStoredFlag(storage, "panel"), true);
  stored.set("panel", "0");
  assert.equal(readStoredFlag(storage, "panel"), false);
});
