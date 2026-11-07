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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import {
  clearFeedbackDraft,
  emptyFeedbackDraft,
  loadFeedbackDraft,
  loadFeedbackHistory,
  readFeedbackInstallId,
  removeFeedbackRecord,
  saveFeedbackDraft,
  saveFeedbackRecord,
  type FeedbackRecord,
  type FeedbackStorage,
} from "../src/feedback/store.js";

function memory(): FeedbackStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

function record(receipt: string): FeedbackRecord {
  return { receipt, kind: "bug", title: "Title", submittedAt: "2026-11-03T10:00:00.000Z", status: "submitted" };
}

test("readFeedbackInstallId returns a stable id and persists it", () => {
  const storage = memory();
  const first = readFeedbackInstallId(storage);
  const second = readFeedbackInstallId(storage);
  assert.equal(first, second);
  assert.ok(first.length > 0);

  const reloaded = memory();
  const fresh = readFeedbackInstallId(reloaded);
  assert.notEqual(fresh, first);
});

test("readFeedbackInstallId keeps one id when storage throws on read", () => {
  const storage: FeedbackStorage = {
    getItem: () => { throw new Error("storage disabled"); },
    setItem: () => { throw new Error("storage disabled"); },
  };
  const first = readFeedbackInstallId(storage);
  const second = readFeedbackInstallId(storage);
  assert.ok(first.length > 0);
  assert.equal(second, first);
});

test("readFeedbackInstallId keeps one id when the write is rejected", () => {
  const storage: FeedbackStorage = {
    getItem: () => null,
    setItem: () => { throw new Error("quota exceeded"); },
  };
  const first = readFeedbackInstallId(storage);
  const second = readFeedbackInstallId(storage);
  assert.ok(first.length > 0);
  assert.equal(second, first);
});

test("emptyFeedbackDraft defaults to bug with diagnostics included", () => {
  assert.deepEqual(emptyFeedbackDraft(), {
    kind: "bug",
    body: "",
    contact: "",
    reproducibility: "",
    impact: "",
    includeDiagnostics: true,
  });
});

test("draft round-trips through storage", () => {
  const storage = memory();
  const draft = { kind: "idea" as const, body: "hello", contact: "a@b.co", reproducibility: "once", impact: "minor", includeDiagnostics: false };
  saveFeedbackDraft(storage, draft);
  assert.deepEqual(loadFeedbackDraft(storage), draft);
  clearFeedbackDraft(storage);
  assert.deepEqual(loadFeedbackDraft(storage), emptyFeedbackDraft());
});

test("a missing or corrupt draft falls back to defaults", () => {
  const empty = memory();
  assert.deepEqual(loadFeedbackDraft(empty), emptyFeedbackDraft());

  const corrupt = memory();
  corrupt.setItem("sciencediscovery-desktop:feedback-draft", "{not json");
  assert.deepEqual(loadFeedbackDraft(corrupt), emptyFeedbackDraft());
});

test("saveFeedbackRecord prepends and caps history at 50", () => {
  const storage = memory();
  const kept = saveFeedbackRecord(storage, record("FB-AAAA-1111"));
  assert.equal(kept.length, 1);

  const withMore = saveFeedbackRecord(storage, record("FB-BBBB-2222"));
  assert.equal(withMore.length, 2);
  assert.equal(withMore[0]!.receipt, "FB-BBBB-2222");
  assert.equal(withMore[1]!.receipt, "FB-AAAA-1111");

  for (let i = 0; i < 60; i += 1) saveFeedbackRecord(storage, record(`FB-CCCC-${String(i).padStart(4, "0")}`));
  assert.equal(loadFeedbackHistory(storage).length, 50);
});

test("loadFeedbackHistory ignores corrupt data and non-records", () => {
  const storage = memory();
  storage.setItem("sciencediscovery-desktop:feedback-history", JSON.stringify([
    record("FB-AAAA-1111"),
    { receipt: 42 },
    "junk",
  ]));
  const history = loadFeedbackHistory(storage);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.receipt, "FB-AAAA-1111");
});

test("removeFeedbackRecord removes only the matching receipt", () => {
  const storage = memory();
  saveFeedbackRecord(storage, record("FB-AAAA-1111"));
  saveFeedbackRecord(storage, record("FB-BBBB-2222"));
  const remaining = removeFeedbackRecord(storage, "FB-AAAA-1111");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.receipt, "FB-BBBB-2222");
});