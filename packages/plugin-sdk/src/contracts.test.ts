// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { PluginBridge, ServiceRegistry, mergePluginSettings, negotiatePlugins, validatePluginSettings, type PluginManifest } from "./index.js";

const manifest: PluginManifest = { id:"test",version:"1.0.0",apiVersion:1,
  configuration:{schemaVersion:1,scopes:["project"],applies:"nextRun",fields:{limit:{type:"number"},token:{type:"string",secretRef:true}}},
  services:{requires:[{id:"store",version:2},{id:"optional",version:1,optional:true}]},permissions:["read"] };
test("configuration validation preserves inheritance without admitting credentials or unknown fields", () => {
  assert.deepEqual(validatePluginSettings({test:{enabled:false,config:{limit:3,token:"secret:key"}}},[manifest]).test?.config,{limit:3,token:"secret:key"});
  for (const value of [{unknown:{}},{test:{config:{token:"credential"}}},{test:{config:{limit:Infinity}}},{test:{other:true}},JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => validatePluginSettings(value,[manifest]));
  }
  const base = {test:{enabled:false,config:{limit:1}}};
  const merged = mergePluginSettings(base,{test:{config:{limit:2}}});
  assert.deepEqual(merged,{test:{enabled:false,config:{limit:2}}});
  merged.test!.config!.limit=9; assert.equal(base.test.config.limit,1);
});
test("availability, authorization and activation are separate; optional contracts do not disable a component", () => {
  const blocked = negotiatePlugins([manifest],{services:[{id:"store",version:1}],permissions:[],active:["test"]})[0]!;
  assert.equal(blocked.available,false); assert.equal(blocked.authorized,false); assert.equal(blocked.active,false);
  const ready = negotiatePlugins([manifest],{services:[{id:"store",version:2}],permissions:["read"]})[0]!;
  assert.equal(ready.available,true); assert.equal(ready.active,false); assert.equal(ready.diagnostics[0]?.code,"optional-service");
  assert.equal(negotiatePlugins([manifest],{services:[{id:"store",version:2}],permissions:["read"],active:["test"]})[0]?.active,true);
  const dependent={...manifest,id:"child",requires:["test"]};
  assert.equal(negotiatePlugins([manifest,dependent],{settings:{test:{enabled:false}},services:[{id:"store",version:2}],permissions:["read"]})[1]?.available,false);
});
test("service registry enforces exact contracts, duplicate ownership and scoped release", () => {
  const registry=new ServiceRegistry(), value={read:()=>1}, release=registry.provide({id:"store",version:2},value);
  assert.equal(registry.require({id:"store",version:2}),value);
  assert.throws(()=>registry.require({id:"store",version:1}),/unavailable/);
  assert.equal(registry.require({id:"store",version:1,optional:true}),undefined);
  assert.throws(()=>registry.provide({id:"store",version:2},value),/already/);
  release();release();assert.deepEqual(registry.describe(),[]);
});
test("bridge binds scope and method kind, rejects prototype dispatch and cancels before mutation", async () => {
  const scope={projectId:"p",sessionId:"s"}, bridge=new PluginBridge(scope,id=>id==="test");
  let state=0;
  const release=bridge.register({id:"test",queries:{read:()=>state},commands:{write:()=>++state}});
  const request={apiVersion:1 as const,pluginId:"test",scope,kind:"query" as const,method:"read"};
  const signal=new AbortController().signal;
  assert.equal(await bridge.invoke(request,signal),0);
  await assert.rejects(bridge.invoke({...request,scope:{projectId:"other"}},signal),/scope/);
  await assert.rejects(bridge.invoke({...request,method:"write"},signal),/unavailable/);
  await assert.rejects(bridge.invoke({...request,method:"toString"},signal),/unavailable/);
  await assert.rejects(bridge.invoke({...request,pluginId:"other"},signal),/denied/);
  const abort=new AbortController();abort.abort();
  await assert.rejects(bridge.invoke({...request,kind:"command",method:"write"},abort.signal));
  assert.equal(state,0);
  assert.equal(await bridge.invoke({...request,kind:"command",method:"write"},signal),1);
  release();await assert.rejects(bridge.invoke(request,signal),/unavailable/);
});
