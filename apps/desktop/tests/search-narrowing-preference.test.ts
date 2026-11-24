// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import {
  readSearchNarrowing, rememberSearchNarrowing, resetSearchNarrowing,
} from "../src/app/search-narrowing-preference.js";
import { DEFAULT_SEARCH_NARROWING } from "../src/app/search-narrowing.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

const KEY = "sciencediscovery-desktop:search-narrowing";

function memory(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    removeItem: (key: string) => { store.delete(key); },
    setItem: (key: string, value: string) => { store.set(key, value); },
  } as Storage;
}

test("the narrowing survives a reload, and only values this build knows are honoured", () => {
  const storage = memory();
  assert.deepEqual(readSearchNarrowing(storage), DEFAULT_SEARCH_NARROWING, "nothing stored means the defaults");

  // #1251 asks for the choice to survive a reload: write it, read it back.
  const narrowed = {
    onlyRunning: true,
    onlyWithArtifacts: true,
    projectIds: ["p1", "p2"],
    window: "custom" as const,
    custom: { from: 1_700_000_000_000, to: 1_700_100_000_000 },
  };
  rememberSearchNarrowing(narrowed, storage);
  assert.deepEqual(readSearchNarrowing(storage), narrowed);

  resetSearchNarrowing(storage);
  assert.deepEqual(readSearchNarrowing(storage), DEFAULT_SEARCH_NARROWING);

  // A window from a build that knew more must not leave the results narrowed in a
  // way nothing on screen explains, and ids that are not strings are dropped.
  storage.setItem(KEY, JSON.stringify({ onlyRunning: "yes", projectIds: ["p1", 3, ""], window: "year" }));
  const recovered = readSearchNarrowing(storage);
  assert.equal(recovered.window, DEFAULT_SEARCH_NARROWING.window);
  assert.equal(recovered.onlyRunning, false);
  assert.deepEqual(recovered.projectIds, ["p1"], "only non-empty strings survive");

  // A custom range is read only while the window is custom.
  storage.setItem(KEY, JSON.stringify({ window: "day", custom: { from: 1, to: 2 } }));
  assert.equal(readSearchNarrowing(storage).custom, undefined);
  storage.setItem(KEY, JSON.stringify({ window: "custom", custom: { from: 1, to: "later" } }));
  assert.equal(readSearchNarrowing(storage).custom, undefined, "a malformed range is no range");

  // Garbage is not a crash.
  storage.setItem(KEY, "{not json");
  assert.deepEqual(readSearchNarrowing(storage), DEFAULT_SEARCH_NARROWING);
  storage.setItem(KEY, "null");
  assert.deepEqual(readSearchNarrowing(storage), DEFAULT_SEARCH_NARROWING);
});

test("a storage that refuses to answer means the defaults, not a failed render", () => {
  const blocked = {
    getItem: () => { throw new Error("blocked"); },
    removeItem: () => {},
    setItem: () => {},
  } as unknown as Storage;
  assert.deepEqual(readSearchNarrowing(blocked), DEFAULT_SEARCH_NARROWING);
  rememberSearchNarrowing({ ...DEFAULT_SEARCH_NARROWING, onlyRunning: true }, blocked);
  assert.deepEqual(readSearchNarrowing(undefined), DEFAULT_SEARCH_NARROWING);
});
