// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import {DurableContextStore,type AgentScope} from "@sciencediscovery/context";
import {createRuntimePluginScope} from "./runtime.js";
import type {WorkspaceAgentOptions} from "@sciencediscovery/workspace";
const workspace:WorkspaceAgentOptions={
  config:{baseUrl:"http://local",dataDir:".tmp",model:"test"},workspaceRoot:".tmp",enabledConnectorIds:[],
  executePython:async()=>{throw new Error("unused");},executeShell:async()=>{throw new Error("unused");},
  runSubagent:async()=>{throw new Error("unused");},
};
for(const scope of ["main","subagent","reviewer"] as const) {
  test(`runtime scope ${scope} honors inherited disables before creating tools or state`,async()=>{
    const plugins=await createRuntimePluginScope({scope,workspace,durable:new DurableContextStore(),
      planStore:{latest:async()=>undefined,update:async()=>{throw new Error("unused");}}},
      [],{plan:{enabled:false},skill:{enabled:false},mcp:{enabled:false},scheduler:{enabled:false}});
    assert.deepEqual(plugins.contributions,[]);
    assert.equal(plugins.status.find(item=>item.id==="plan")?.enabled,false);
    await plugins.start(new AbortController().signal);
    assert.ok(plugins.status.every(item=>!item.active));
    await plugins.dispose();
  });
}
test("installed Plan is unavailable without its port; activation and disposal are observable separately",async()=>{
  const plugins=await createRuntimePluginScope({scope:"main" as AgentScope,workspace,durable:new DurableContextStore()});
  const plan=plugins.status.find(item=>item.id==="plan")!;
  assert.equal(plan.installed,true);assert.equal(plan.available,false);
  assert.ok(plan.diagnostics.some(item=>item.code==="required-service"));
  assert.ok(plugins.status.every(item=>!item.active));
  await plugins.start(new AbortController().signal);
  assert.equal(plugins.status.find(item=>item.id==="scheduler")?.active,true);
  await plugins.dispose();assert.ok(plugins.status.every(item=>!item.active));
});
