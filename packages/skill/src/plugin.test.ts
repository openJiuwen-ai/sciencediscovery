// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { DurableContextStore } from "@sciencediscovery/context";
import { createPluginScope } from "@sciencediscovery/plugin-sdk";
import { skillPlugin } from "./plugin.js";
test("Skill package can be disabled without constructing a second tool path", async () => {
  const ports = { skills: [], durable: new DurableContextStore(), scope: "main" as const };
  const scope = await createPluginScope([skillPlugin(ports)], ["skill"]);
  assert.deepEqual(scope.contributions, []);
  await scope.start(new AbortController().signal); await scope.dispose();
});
test("empty selection has no Skill context or read tools", async () => {
  const scope = await createPluginScope([skillPlugin({ skills: [], durable: new DurableContextStore(), scope: "reviewer" })]);
  assert.deepEqual(scope.contributions[0]!.tools, []);
  assert.deepEqual(scope.contributions[0]!.contextFactories, []);
  await scope.dispose();
});
