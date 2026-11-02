// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function fixture(context: { after(action: () => Promise<void>): void }) {
  const parent=resolve(process.cwd(),'.tmp'),root=resolve(parent,'connection-atomic-'+randomUUID()),store=new SessionStore(root);await store.load();context.after(async()=>{store.close();assert.ok(root.startsWith(parent+sep));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:20});});return {root,store};
}
const connection={name:'Owned original',baseUrl:'https://owned-initial.invalid/v1',apiProtocol:'openai-chat-completions' as const,apiVariant:'openai' as const};
const secrets=(store:SessionStore)=>store.getConfigurationDatabase().prepare('SELECT model_id,encrypted_token FROM model_secrets ORDER BY model_id').all();
test('CFG-XBUG-08: invalid provider proxy leaves all connection metadata, child models and ciphertext unchanged',async context=>{
  const {root,store}=await fixture(context),provider=await store.createProvider({...connection,apiToken:'synthetic-provider-only'}),profile=await store.materializeProviderModel(provider.id,'owned-child');
  const before=structuredClone(provider),child=structuredClone(profile),cipher=secrets(store);
  await assert.rejects(store.updateProvider(provider.id,{name:'Rejected provider name',baseUrl:'https://owned-rejected.invalid/v1',proxyPolicy:'proxy:missing',apiToken:'synthetic-must-not-replace'}));
  assert.deepEqual(store.getProvider(provider.id),before);assert.deepEqual(store.getModel(profile.id),child);assert.deepEqual(secrets(store),cipher);
  await store.replaceGlobalSettings(store.getGlobalSettings().overrides);const reopened=new SessionStore(root);await reopened.load();try{assert.equal(reopened.getProvider(provider.id)?.name,before.name);assert.equal(reopened.getProvider(provider.id)?.baseUrl,before.baseUrl);}finally{reopened.close();}
  const saved=await store.updateProvider(provider.id,{proxyPolicy:'none'});assert.equal(saved.proxyPolicy,'none');assert.equal(store.getModel(profile.id)?.proxyPolicy,'none');assert.deepEqual(secrets(store),cipher);
});
test('CFG-XBUG-08: invalid standalone-model proxy cannot leak a rejected name/endpoint into a later save',async context=>{
  const {root,store}=await fixture(context),profile=await store.createModel({...connection,model:'owned-model',apiToken:'synthetic-model-only'}),before=structuredClone(profile),cipher=secrets(store);
  const update={...connection,model:profile.model,name:'Rejected model name',baseUrl:'https://owned-rejected.invalid/v1',proxyPolicy:'proxy:missing' as const,apiToken:'synthetic-must-not-replace'};
  await assert.rejects(store.updateModel(profile.id,update));assert.deepEqual(store.getModel(profile.id),before);assert.deepEqual(secrets(store),cipher);
  await store.replaceGlobalSettings(store.getGlobalSettings().overrides);const reopened=new SessionStore(root);await reopened.load();try{assert.equal(reopened.getModel(profile.id)?.name,before.name);assert.equal(reopened.getModel(profile.id)?.baseUrl,before.baseUrl);}finally{reopened.close();}
  assert.equal((await store.updateModel(profile.id,{...connection,model:profile.model,proxyPolicy:'none'})).proxyPolicy,'none');assert.deepEqual(secrets(store),cipher);
});

test('CFG-XBUG-08: rejected empty/oversize token validation also precedes live connection mutation',async context=>{
  const {store}=await fixture(context),provider=await store.createProvider({...connection,apiToken:'synthetic-provider-only'}),profile=await store.createModel({...connection,model:'owned-model',apiToken:'synthetic-model-only'});
  const providerBefore=structuredClone(provider),modelBefore=structuredClone(profile),cipher=secrets(store);
  for(const apiToken of ['', 'x'.repeat(16385)]){
    await assert.rejects(store.updateProvider(provider.id,{name:'Rejected credential edit',baseUrl:'https://owned-rejected.invalid/v1',proxyPolicy:'none',apiToken}));
    await assert.rejects(store.updateModel(profile.id,{...connection,model:profile.model,name:'Rejected credential edit',baseUrl:'https://owned-rejected.invalid/v1',proxyPolicy:'none',apiToken}));
    assert.deepEqual(store.getProvider(provider.id),providerBefore);assert.deepEqual(store.getModel(profile.id),modelBefore);assert.deepEqual(secrets(store),cipher);
  }
});
