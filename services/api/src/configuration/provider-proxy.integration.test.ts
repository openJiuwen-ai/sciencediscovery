// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {rm} from 'node:fs/promises';import {resolve,sep} from 'node:path';
import type {ConfigurationRequestView,ConfigurationValues} from '@sciencediscovery/schema';import {createTest} from '../../../../test/support/tagged/compat.mjs';import {SessionStore} from '../store.js';import {configurationFramework} from './framework.js';import {discoverConfiguration} from './discovery.js';
const {test}=createTest(import.meta.url,{tags:['category:ut','os:linux','os:windows','arch:amd64','arch:arm64']});
async function fixture(context:{after(action:()=>Promise<void>):void}){
 const parent=resolve(process.cwd(),'.tmp'),root=resolve(parent,'provider-proxy-'+randomUUID()),store=new SessionStore(root);await store.load();context.after(async()=>{store.close();assert.ok(root.startsWith(parent+sep));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:20});});
 const provider=await store.createProvider({name:'Owned primary',baseUrl:'https://owned-primary.invalid/v1',apiProtocol:'openai-chat-completions',apiVariant:'openai',apiToken:'synthetic-primary'}),other=await store.createProvider({name:'Owned other',baseUrl:'https://owned-other.invalid/v1',apiProtocol:'openai-chat-completions',apiVariant:'openai',apiToken:'synthetic-other'});
 const first=await store.materializeProviderModel(provider.id,'owned-first'),second=await store.materializeProviderModel(provider.id,'owned-second'),otherModel=await store.materializeProviderModel(other.id,'owned-other');
 const proxy=await store.createProxyServer({name:'Owned proxy',kind:'custom_url',url:'http://owned-user:synthetic-proxy@127.0.0.1:1'}),project=await store.createProject('Provider proxy'),session=await store.createSession(project.id,'Target',{}, {},{allowUnconfiguredModel:true});
 const framework=configurationFramework(store,{nativeExecutor:true,connector:()=>undefined}),policy=`proxy:${proxy.id}`;
 const propose=(values:ConfigurationValues)=>framework.propose(session.id,{protocolVersion:3,capabilityId:'proxy.provider',values});
 const approval=(card:ConfigurationRequestView)=>({revision:card.revision,previewDigest:card.previewDigest!,selectedOptionId:'persist',decision:'apply' as const});
 return {store,root,provider,other,first,second,otherModel,proxy,project,session,framework,policy,propose,approval};
}
const cipher=(store:SessionStore)=>({models:store.getConfigurationDatabase().prepare('SELECT model_id,encrypted_token FROM model_secrets ORDER BY model_id').all(),proxies:store.getConfigurationDatabase().prepare('SELECT server_id,encrypted_url FROM proxy_server_secrets ORDER BY server_id').all()});
const withoutRoute=(value:object)=>Object.fromEntries(Object.entries(value).filter(([key])=>!['proxyPolicy','updatedAt'].includes(key)));
test('CFG-X03d: manual shared proxy save syncs child profiles once without decrypting keys or exposing proxy URLs',async context=>{
 const h=await fixture(context),before=structuredClone(h.provider),other=structuredClone(h.other),otherModel=structuredClone(h.otherModel),secrets=cipher(h.store);let reads=0;
 h.store.getProviderApiToken=()=>{reads++;throw Error('Old plaintext access forbidden');};h.store.getModelApiToken=()=>{reads++;throw Error('Old plaintext access forbidden');};h.store.getProxySettings=()=>{throw Error('Full secret-bearing proxy view forbidden');};
 const card=await h.propose({providerId:h.provider.id,proxyPolicy:h.policy});assert.equal(card.scope.kind,'global');assert.equal(card.autoApplyAt,undefined);assert.deepEqual(h.store.getProvider(h.provider.id),before);assert.equal((await h.framework.decide(h.session.id,card.id,h.approval(card))).state,'applied');
 const saved=structuredClone(h.store.getProvider(h.provider.id)!);assert.equal(saved.proxyPolicy,h.policy);assert.deepEqual(withoutRoute(saved),withoutRoute(before));assert.equal(h.store.getModel(h.first.id)?.proxyPolicy,h.policy);assert.equal(h.store.getModel(h.second.id)?.proxyPolicy,h.policy);assert.deepEqual(h.store.getProvider(h.other.id),other);assert.deepEqual(h.store.getModel(h.otherModel.id),otherModel);assert.deepEqual(cipher(h.store),secrets);assert.equal(reads,0);
 await h.framework.decide(h.session.id,card.id,h.approval(card));assert.deepEqual(h.store.getProvider(h.provider.id),saved);
});
test('CFG-X03d: empty/provider-only cards collect input; unchanged routes need no decision; v3/global finite fields are enforced',async context=>{
 const h=await fixture(context);await assert.rejects(h.propose({providerId:h.provider.id,proxyPolicy:'inherit'}),{code:'CONFIGURATION_NO_CHANGE'});assert.equal((await h.propose({})).state,'collecting_input');assert.equal((await h.propose({providerId:h.provider.id})).state,'collecting_input');
 const invalid:ConfigurationValues[]=[{providerId:h.provider.id,proxyPolicy:'proxy:missing'},{providerId:h.provider.id,proxyPolicy:'http://owned-user:synthetic-proxy@127.0.0.1:1'},{providerId:h.provider.id,apiToken:'synthetic-forbidden'},{providerId:h.provider.id,url:'http://127.0.0.1:1'}];for(const values of invalid)await assert.rejects(h.propose(values),{code:'INVALID_CONFIGURATION_INPUT'});
 await assert.rejects(h.propose({providerId:'missing',proxyPolicy:'none'}),{code:'CONFIGURATION_RESOURCE_UNAVAILABLE'});await assert.rejects(h.framework.propose(h.session.id,{capabilityId:'proxy.provider',values:{providerId:h.provider.id,proxyPolicy:'none'}}),{code:'CONFIGURATION_PROTOCOL_REQUIRED'});
 for(const scope of [{kind:'session' as const,id:h.session.id},{kind:'project' as const,id:h.project.id}])await assert.rejects(h.framework.propose(h.session.id,{protocolVersion:3,capabilityId:'proxy.provider',values:{providerId:h.provider.id,proxyPolicy:'none'},scope}),{code:'INVALID_CONFIGURATION_SCOPE'});
});
test('CFG-X03d: endpoint, token and proxy URL rotation invalidate old route approvals',async context=>{
 for(const mutation of ['endpoint','token','proxy'] as const){const h=await fixture(context),card=await h.propose({providerId:h.provider.id,proxyPolicy:h.policy});
  if(mutation==='endpoint')await h.store.updateProvider(h.provider.id,{baseUrl:'https://owned-new.invalid/v1'});else if(mutation==='token')await h.store.updateProvider(h.provider.id,{apiToken:'synthetic-rotated'});else await h.store.updateProxyServer(h.proxy.id,{url:'http://owned-user:synthetic-rotated@127.0.0.1:2'});
  await assert.rejects(h.framework.decide(h.session.id,card.id,h.approval(card)),{code:'RESOURCE_VERSION_CONFLICT'});assert.equal(h.store.getProvider(h.provider.id)?.proxyPolicy,'inherit');
 }
});
test('CFG-X03d: unrelated provider edits do not invalidate the selected provider route',async context=>{
 const h=await fixture(context),card=await h.propose({providerId:h.provider.id,proxyPolicy:'none'});await h.store.updateProvider(h.other.id,{name:'Unrelated renamed provider'});assert.equal((await h.framework.decide(h.session.id,card.id,h.approval(card))).state,'applied');assert.equal(h.store.getProvider(h.provider.id)?.proxyPolicy,'none');
});
test('CFG-X03d: receipt failure rolls provider and child-model route changes back with ciphertext unchanged',async context=>{
 const h=await fixture(context),before=structuredClone(h.provider),first=structuredClone(h.first),second=structuredClone(h.second),secrets=cipher(h.store),card=await h.propose({providerId:h.provider.id,proxyPolicy:h.policy});const db=h.store.getConfigurationDatabase();
 db.exec("CREATE TRIGGER reject_provider_proxy_receipt BEFORE INSERT ON configuration_receipts_v2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");assert.equal((await h.framework.decide(h.session.id,card.id,h.approval(card))).state,'failed');assert.deepEqual(h.store.getProvider(h.provider.id),before);assert.deepEqual(h.store.getModel(h.first.id),first);assert.deepEqual(h.store.getModel(h.second.id),second);assert.deepEqual(cipher(h.store),secrets);assert.equal(h.framework.repository.getReceipt(card.id),undefined);db.exec('DROP TRIGGER reject_provider_proxy_receipt');
});
test('CFG-X03d: refusal and Stop preserve the shared route; discovery returns bounded safe provider metadata',async context=>{
 const h=await fixture(context);h.store.getProxySettings=()=>{throw Error('Full proxy view forbidden');};
 const described=await discoverConfiguration(h.store,h.session.id,'owned-no-run','describe',{capabilityId:'proxy.provider',targetId:h.provider.id});const raw=JSON.stringify(described);assert.ok(raw.includes(h.provider.id));for(const forbidden of ['synthetic-primary','synthetic-proxy','owned-user','https://owned-primary.invalid','http://127.0.0.1'])assert.ok(!raw.includes(forbidden));
 let card=await h.propose({providerId:h.provider.id,proxyPolicy:'none'});card=await h.framework.preview(h.session.id,card.id,{expectedRevision:card.revision,values:{},selectedOptionId:'dismiss'});assert.equal((await h.framework.decide(h.session.id,card.id,{...h.approval(card),selectedOptionId:'dismiss',decision:'dismiss'})).state,'dismissed');
 card=await h.propose({providerId:h.provider.id,proxyPolicy:'none'});h.store.notifications.stop(h.session.id);await assert.rejects(h.framework.decide(h.session.id,card.id,h.approval(card)));assert.equal(h.store.getProvider(h.provider.id)?.proxyPolicy,'inherit');
});
