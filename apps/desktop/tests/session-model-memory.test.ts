// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { modelForNewConversation, readRememberedModel, writeRememberedModel } from "../src/app/session-model-memory.js";
import type { ReadableStorage } from "../src/state/storage.js";

function memoryStorage(): ReadableStorage {
  const map = new Map<string, string>();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, removeItem: (key) => { map.delete(key); } };
}

const CATALOG = [{ id: "first" }, { id: "second" }];

test("a remembered model still in the catalog is what a new conversation starts from", () => {
  assert.equal(modelForNewConversation("second", CATALOG), "second");
  assert.equal(modelForNewConversation("first", CATALOG), "first");
});

test("nothing remembered leaves the choice to the project or global default", () => {
  assert.equal(modelForNewConversation(undefined, CATALOG), undefined);
});

test("a remembered model that left the catalog is not handed to the server", () => {
  // The id would name a model this instance cannot run: fall back instead of dangling.
  assert.equal(modelForNewConversation("retired", CATALOG), undefined);
  assert.equal(modelForNewConversation("retired", []), undefined);
});

test("an explicit pick survives a restart through storage", () => {
  const storage = memoryStorage();
  writeRememberedModel(storage, "second");
  // A new instance reads the same storage: that is the restart the issue asks for.
  assert.equal(readRememberedModel(storage), "second");
  writeRememberedModel(storage, "first");
  assert.equal(readRememberedModel(storage), "first");
});

test("forgetting the pick clears it, and a missing or broken storage is not fatal", () => {
  const storage = memoryStorage();
  writeRememberedModel(storage, "second");
  writeRememberedModel(storage, undefined);
  assert.equal(readRememberedModel(storage), undefined);
  assert.equal(readRememberedModel(undefined), undefined, "no storage means no memory, not a crash");
  const broken: ReadableStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assert.equal(readRememberedModel(broken), undefined);
  assert.doesNotThrow(() => writeRememberedModel(broken, "second"));
});
