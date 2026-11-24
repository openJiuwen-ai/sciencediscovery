// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import {
  readListFilters, rememberListFilters, resetListFilters,
} from "../src/app/list-filters-preference.js";
import { DEFAULT_SESSION_FILTERS } from "../src/app/session-filters.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

function memory(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    removeItem: (key: string) => { store.delete(key); },
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
}

test("the narrowed list survives a reload, and only known values are honoured", () => {
  const storage = memory() as unknown as Storage;
  assert.deepEqual(readListFilters(storage), DEFAULT_SESSION_FILTERS, "nothing stored means the defaults");

  // #1251 asks for the choice to survive a reload: write it, read it back from a
  // fresh read — this is what the next page load does.
  const narrowed = { onlyRunning: true, onlyWithArtifacts: true, scope: "current" as const, window: "today" as const };
  rememberListFilters(narrowed, storage);
  assert.deepEqual(readListFilters(storage), narrowed);

  resetListFilters(storage);
  assert.deepEqual(readListFilters(storage), DEFAULT_SESSION_FILTERS);

  // A value from a build that knew more must not leave the list narrowed in a way
  // nothing on screen can explain.
  rememberListFilters({ ...DEFAULT_SESSION_FILTERS, scope: "week" as never, window: "year" as never }, storage);
  const recovered = readListFilters(storage);
  assert.equal(recovered.scope, DEFAULT_SESSION_FILTERS.scope);
  assert.equal(recovered.window, DEFAULT_SESSION_FILTERS.window);

  // Garbage is not a crash.
  (storage as unknown as Storage).setItem("sciencediscovery-desktop:list-filters", "{not json");
  assert.deepEqual(readListFilters(storage), DEFAULT_SESSION_FILTERS);
  (storage as unknown as Storage).setItem("sciencediscovery-desktop:list-filters", "null");
  assert.deepEqual(readListFilters(storage), DEFAULT_SESSION_FILTERS);
});

test("a storage that refuses to answer means the defaults, not a failed render", () => {
  const blocked = {
    getItem: () => { throw new Error("blocked"); },
    removeItem: () => {},
    setItem: () => {},
  };
  assert.deepEqual(readListFilters(blocked as unknown as Storage), DEFAULT_SESSION_FILTERS);
  // Writing into it is equally harmless.
  rememberListFilters({ ...DEFAULT_SESSION_FILTERS, onlyRunning: true }, blocked as unknown as Storage);
  assert.deepEqual(readListFilters(undefined), DEFAULT_SESSION_FILTERS);
});
