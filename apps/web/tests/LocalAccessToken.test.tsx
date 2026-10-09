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


import { loadLocalAccessToken } from "../src/local-access-token.js";
import { TOKEN_STORAGE_KEY } from "../src/browser-storage.js";

function browser(href: string, saved?: string) {
  const values = new Map(saved === undefined ? [] : [[TOKEN_STORAGE_KEY, saved]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const location = { href };
  const state = { existing: "history state" };
  const history = { state, replaceState: (next: unknown, _unused: string, path?: string | URL | null) => {
    assert.equal(next, state);
    location.href = new URL(String(path), location.href).href;
  } };
  return { storage, location, history };
}

test("startup link overrides a stale token before requests, persists and removes only its fragment parameter", () => {
  const token = "local+token/with?reserved=&字符";
  const b = browser(`http://localhost:4320/projects/p?session=s#token=${encodeURIComponent(token)}&section=notes`, "stale");
  assert.equal(loadLocalAccessToken(b.storage, b.location, b.history), token);
  assert.equal(b.storage.getItem(TOKEN_STORAGE_KEY), token);
  assert.equal(b.location.href, "http://localhost:4320/projects/p?session=s#section=notes");
  // A repeat initialization or reload uses the persisted credential.
  assert.equal(loadLocalAccessToken(b.storage, b.location, b.history), token);
});

test("ordinary links keep saved or legacy credentials and unrelated fragments", () => {
  const b = browser("http://localhost:4320/?view=usage#notes");
  b.storage.setItem("science-agent-token", "legacy");
  assert.equal(loadLocalAccessToken(b.storage, b.location, b.history), "legacy");
  assert.equal(b.location.href, "http://localhost:4320/?view=usage#notes");
});

test("an empty URL token never erases a saved token", () => {
  const b = browser("http://localhost:4320/#token=", "saved");
  assert.equal(loadLocalAccessToken(b.storage, b.location, b.history), "saved");
  assert.equal(b.location.href, "http://localhost:4320/");
});

test("a new browser starts empty without a default credential", () => {
  const b = browser("http://localhost:4320/");
  assert.equal(loadLocalAccessToken(b.storage, b.location, b.history), "");
});

test("a failed storage write does not discard the sign-in link", () => {
  const b = browser("http://localhost:4320/#token=local-token");
  b.storage.setItem = () => { throw new Error("storage unavailable"); };
  assert.throws(() => loadLocalAccessToken(b.storage, b.location, b.history), /storage unavailable/);
  assert.equal(new URL(b.location.href).hash, "#token=local-token");
});
