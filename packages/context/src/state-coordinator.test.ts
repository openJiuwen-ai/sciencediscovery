// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { StateCoordinator, migrateComponentState } from "./state-coordinator.js";
import { createStateView, type ComponentState } from "./state-view.js";
import { ContextContributorRegistry } from "./contributor.js";
test("commands serialize with captures and reject ABA revision reuse", async () => {
  const coordinator=new StateCoordinator();let value=0;
  const before=await coordinator.capture(async()=>value);
  let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});
  const mutation=coordinator.command(async()=>{value=1;await wait;value=0;});
  let captured=false;const after=coordinator.capture(async()=>{captured=true;return value;});
  await Promise.resolve();assert.equal(captured,false);release();await mutation;
  assert.deepEqual(await after,{value:0,revision:"1"});assert.equal(before.revision,"0");
  await assert.rejects(coordinator.command(async()=>{throw new Error("partial");}),/partial/);
  assert.equal((await coordinator.capture(async()=>value)).revision,"2");
});
test("migration is explicit, JSON-only and does not mutate the source snapshot", () => {
  const state:ComponentState={id:"plan",schemaVersion:1,revision:"r",fidelity:"captured",value:{old:1}};
  const next=migrateComponentState(state,2,new Map([[1,()=>({next:2})]]));
  assert.equal(next.schemaVersion,2);assert.deepEqual(state.value,{old:1});
  assert.throws(()=>migrateComponentState(next,1,new Map()),/downgrade/);
  assert.throws(()=>migrateComponentState(state,2,new Map()),/Missing/);
  assert.throws(()=>migrateComponentState(state,NaN,new Map()),/Invalid/);
  assert.throws(()=>migrateComponentState(state,2,new Map([[1,()=>undefined]])),/JSON/);
});
test("contributors without declared stateReads receive an empty view", async () => {
  const view=createStateView({id:"c",scope:"main",components:[{id:"secret",schemaVersion:1,revision:"r",value:{data:1},fidelity:"captured"}]});
  const registry=new ContextContributorRegistry().register({id:"undeclared",scopes:["main"],async contribute(request){
    assert.deepEqual(request.stateView?.checkpoint.components,[]);
    assert.throws(()=>request.stateView?.read("secret"),/not available/);
    return {};
  }}).freeze();
  await registry.collect({stateView:view,contextId:"c",scope:"main",history:[],turn:1,signal:new AbortController().signal});
});
