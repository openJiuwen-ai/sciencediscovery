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
import test from "node:test";

import {
  legacyStorageKey,
  readRenamedStorageItem,
  TOKEN_STORAGE_KEY,
} from "../src/browser-storage.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
}

test("the current key names carry the product name", () => {
  assert.equal(TOKEN_STORAGE_KEY, "sciencediscovery-token");
  assert.equal(legacyStorageKey(TOKEN_STORAGE_KEY), "science-agent-token");
  assert.equal(legacyStorageKey("sciencediscovery:csv-workspace:v1:artifact"), "science-agent:csv-workspace:v1:artifact");
  assert.equal(legacyStorageKey("unrelated-key"), undefined);
});

test("a value stored only under the former key is imported once", () => {
  const storage = fakeStorage({ "science-agent-token": "kept-token" });

  assert.equal(readRenamedStorageItem(storage, TOKEN_STORAGE_KEY), "kept-token");
  assert.equal(storage.entries.get(TOKEN_STORAGE_KEY), "kept-token");
  assert.equal(storage.entries.has("science-agent-token"), false);
  // The import already happened; the second read comes from the current key.
  assert.equal(readRenamedStorageItem(storage, TOKEN_STORAGE_KEY), "kept-token");
});

test("the current key wins and the former key is left untouched", () => {
  const storage = fakeStorage({ "science-agent-token": "stale", "sciencediscovery-token": "current" });

  assert.equal(readRenamedStorageItem(storage, TOKEN_STORAGE_KEY), "current");
  assert.equal(storage.entries.get("science-agent-token"), "stale");
});

test("an unwritable storage still serves the former value", () => {
  const storage = {
    getItem: (key: string) => (key === "science-agent-token" ? "kept-token" : null),
    setItem: () => { throw new Error("quota exceeded"); },
  };

  assert.equal(readRenamedStorageItem(storage, TOKEN_STORAGE_KEY), "kept-token");
});

test("neither key present reads as absent", () => {
  assert.equal(readRenamedStorageItem(fakeStorage(), TOKEN_STORAGE_KEY), null);
});
