// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createPluginScope } from "@sciencediscovery/plugin-sdk";
import { captureStateView, ContextContributorRegistry, registerContextContributorFactories } from "@sciencediscovery/context";
import { planPlugin } from "./plugin.js";

test("plan plugin owns tools, batch policy and fixed-state projection together", async () => {
  let latestCalls = 0;
  const plugin = planPlugin({ latest: async () => { latestCalls++; return undefined; }, update: async () => { throw new Error("not used"); } }, ["main"]);
  const scope = await createPluginScope([plugin]);
  const contribution = scope.contributions[0]!;
  assert.equal(contribution.tools[0]!.name, "update_plan");
  assert.equal(contribution.batchPolicies[0]!.decide([{ id: "a", name: "update_plan", args: {} }, { id: "b", name: "update_plan", args: {} }])[0]!.callId, "a");
  const signal = new AbortController().signal;
  const stateView = await captureStateView({ id: "run:1", scope: "session", providers: contribution.stateProviders, signal });
  const calls = latestCalls;
  const registry = registerContextContributorFactories(new ContextContributorRegistry(), contribution.contextFactories, { contextId: "ctx", scope: "main" }).freeze();
  await registry.collect({ contextId: "ctx", scope: "main", history: [], turn: 1, signal, stateView });
  assert.equal(latestCalls, calls, "projection must not reread latest even when captured Plan is absent");
  await scope.dispose();
});
