// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createPluginScope, type PluginDefinition } from "./index.js";

test("dependency order, single start and reverse disposal", async () => {
  const events: string[] = [];
  const plugin = (id: string, requires: string[] = []): PluginDefinition<string> => ({
    manifest: { id, version: "1", apiVersion: 1, requires },
    create: () => ({ contribution: id, start: async () => { events.push(id); }, dispose: () => { events.push(`dispose:${id}`); } }),
  });
  const scope = await createPluginScope([plugin("child", ["base"]), plugin("base")]);
  assert.deepEqual(scope.contributions, ["base", "child"]);
  await scope.start(new AbortController().signal);
  await assert.rejects(scope.start(new AbortController().signal), /already/);
  await scope.dispose(); await scope.dispose();
  assert.deepEqual(events, ["base", "child", "dispose:child", "dispose:base"]);
  await assert.rejects(createPluginScope([plugin("child", ["base"]), plugin("base")], ["base"]), /unavailable/);
  await assert.rejects(createPluginScope([plugin("a", ["b"]), plugin("b", ["a"])]), /cycle/);
  await assert.rejects(createPluginScope([plugin("a"), plugin("a")]), /Duplicate/);
});
test("failed activation releases earlier factories; failed start disposes every instance", async () => {
  let disposed = 0;
  const good: PluginDefinition<number> = { manifest: { id: "good", version: "1", apiVersion: 1 }, create: () => ({ contribution: 1, dispose: () => { disposed++; } }) };
  await assert.rejects(createPluginScope([good, { manifest: { id: "bad", version: "1", apiVersion: 1 }, create() { throw new Error("create failure"); } }]), /create failure/);
  assert.equal(disposed, 1);
  const scope = await createPluginScope([good, { manifest: { id: "bad", version: "1", apiVersion: 1 }, create: () => ({ contribution: 2, start: async () => { throw new Error("start failure"); }, dispose: () => { disposed++; } }) }]);
  await assert.rejects(scope.start(new AbortController().signal), /start failure/);
  assert.equal(disposed, 3);
});
