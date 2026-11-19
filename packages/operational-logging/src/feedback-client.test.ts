// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { createFeedbackOpenHook, createFeedbackStore } from "./feedback-client.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"],
});

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

test("feedback store persists drafts, caps history and removes one receipt", () => {
  const store = createFeedbackStore("test-feedback");
  const local = storage();
  const install = store.readFeedbackInstallId(local);
  assert.equal(install, store.readFeedbackInstallId(local));
  const draft = { ...store.emptyFeedbackDraft(), body: "draft", includeDiagnostics: false };
  store.saveFeedbackDraft(local, draft);
  assert.deepEqual(store.loadFeedbackDraft(local), draft);
  store.saveFeedbackDraft(local, { ...draft, kind: "idea" });
  assert.equal(store.loadFeedbackDraft(local).kind, "idea");
  for (let index = 0; index < 55; index += 1) {
    store.saveFeedbackRecord(local, { receipt: `FB-${index}`, kind: "bug", title: String(index), submittedAt: String(index), status: "submitted" });
  }
  assert.equal(store.loadFeedbackHistory(local).length, 50);
  assert.equal(store.loadFeedbackHistory(local)[0]?.receipt, "FB-54");
  assert.equal(store.removeFeedbackRecord(local, "FB-54").some((item) => item.receipt === "FB-54"), false);
});

test("feedback open hook delivers the latest seed and unsubscribes cleanly", () => {
  const hook = createFeedbackOpenHook();
  const received: unknown[] = [];
  const unsubscribe = hook.subscribeFeedbackOpen((seed) => received.push(seed));
  const seed = { kind: "bug" as const, title: "Broken", body: "details" };
  hook.openFeedback(seed);
  assert.deepEqual(received, [seed]);
  unsubscribe();
  hook.openFeedback({ title: "ignored" });
  assert.deepEqual(received, [seed]);
});
