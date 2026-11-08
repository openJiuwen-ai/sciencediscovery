// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ConfigurationRequestView, ConfigurationValues } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { configurationFramework } from "./framework.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent=resolve(process.cwd(),'.tmp'),root=resolve(parent,'configuration-automatic-'+randomUUID()),store=new SessionStore(root);await store.load();
  context.after(async()=>{store.close();assert.ok(root.startsWith(parent+sep));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:20});});
  const project=await store.createProject('Automatic configuration'),session=await store.createSession(project.id,'Target',{}, {},{allowUnconfiguredModel:true}),other=await store.createSession(project.id,'Other',{}, {},{allowUnconfiguredModel:true});
  const framework=configurationFramework(store,{nativeExecutor:true,connector:()=>({name:'PubMed',ready:true})});
  const propose=(values:ConfigurationValues)=>framework.propose(session.id,{protocolVersion:3,capabilityId:'security.automatic_configuration',values});
  const approval=(card:ConfigurationRequestView)=>({revision:card.revision,previewDigest:card.previewDigest!,decision:'apply' as const,selectedOptionId:'persist'});
  const consent=(card:ConfigurationRequestView)=>framework.confirmSecurity(session.id,card.id,{revision:card.revision,targetDigest:card.securityConsent!.targetDigest,acknowledged:true});
  const save=async(card:ConfigurationRequestView)=>{await consent(card);return framework.decide(session.id,card.id,approval(card));};
  return {root,store,project,session,other,framework,propose,approval,consent,save};
}
test('CFG-X10c: independent human consent is mandatory and existing tool Always allow never enables automatic configuration',async context=>{
  const h=await harness(context);await h.store.setApprovalMode(h.session.id,'always_allow');const card=await h.propose({autoApplyLowRiskConfiguration:true});assert.equal(card.autoApplyAt,undefined);assert.equal(card.scope.kind,'session');
  await assert.rejects(h.framework.decide(h.session.id,card.id,h.approval(card)),{code:'SECURITY_CONSENT_REQUIRED'});await h.consent(card);
  await assert.rejects(h.framework.decide(h.session.id,card.id,h.approval(card),undefined,'auto'),{code:'CONFIGURATION_AUTO_NOT_AUTHORIZED'});assert.equal(h.store.getSession(h.session.id)?.autoApplyLowRiskConfiguration,false);
});
test('CFG-X10c: manual save/replay persists only the Session flag and never reports a verified tool or resumes a Run',async context=>{
  const h=await harness(context),before=h.store.getSession(h.session.id)!,network=h.store.getSandboxNetworkSettings(),card=await h.propose({autoApplyLowRiskConfiguration:true});const saved=await h.save(card);assert.equal(saved.state,'applied');assert.equal(saved.activation.mode,'next_request');assert.equal(saved.activation.state,'needs_user_action');assert.equal(saved.resumption.state,'not_requested');await h.framework.decide(h.session.id,card.id,h.approval(card));
  const after=h.store.getSession(h.session.id)!;assert.equal(after.autoApplyLowRiskConfiguration,true);assert.equal(after.approvalMode,before.approvalMode);assert.equal(after.permissionEpochId,before.permissionEpochId);assert.equal(h.store.getSession(h.other.id)?.autoApplyLowRiskConfiguration,false);assert.deepEqual(h.store.getSandboxNetworkSettings(),network);
  const reopened=new SessionStore(h.root);await reopened.load();try{assert.equal(reopened.getSession(h.session.id)?.autoApplyLowRiskConfiguration,true);}finally{reopened.close();}
});
test('CFG-X10c: only a boolean and this Session v3 scope are allowed; empty/no-change cards keep their semantics',async context=>{
  const h=await harness(context), invalid: ConfigurationValues[] = [{autoApplyLowRiskConfiguration:'true'},{enabled:true},{autoApplyLowRiskConfiguration:true,acknowledged:true}];for(const values of invalid)await assert.rejects(h.propose(values),{code:'INVALID_CONFIGURATION_INPUT'});
  for(const scope of [{kind:'global' as const},{kind:'project' as const,id:h.project.id},{kind:'session' as const,id:h.other.id}])await assert.rejects(h.framework.propose(h.session.id,{protocolVersion:3,capabilityId:'security.automatic_configuration',values:{autoApplyLowRiskConfiguration:true},scope}));
  await assert.rejects(h.framework.propose(h.session.id,{capabilityId:'security.automatic_configuration',values:{autoApplyLowRiskConfiguration:true}}),{code:'CONFIGURATION_PROTOCOL_REQUIRED'});await assert.rejects(h.propose({autoApplyLowRiskConfiguration:false}),{code:'CONFIGURATION_NO_CHANGE'});assert.equal((await h.propose({})).state,'collecting_input');
});
test('CFG-X10c: disabling withdraws old windows permanently while v3 connector choices remain manual',async context=>{
  const h=await harness(context);await h.save(await h.propose({autoApplyLowRiskConfiguration:true}));const run=await h.store.createSessionRun({sessionId:h.session.id,prompt:'Owned pending connector',settingsSnapshot:h.store.resolveRuntimeSettings(h.session.id).effective});
  const old=await h.framework.propose(h.session.id,{capabilityId:'connector.enable',values:{connectorId:'pubmed'},runId:run.id});assert.ok(old.autoApplyAt);
  await h.save(await h.propose({autoApplyLowRiskConfiguration:false}));assert.equal(h.framework.service.get(h.session.id,old.id).autoApplyAt,undefined);assert.equal(h.store.getConnectorConfigurationRequest(h.session.id,old.id)?.autoApplyAt,undefined);
  await h.save(await h.propose({autoApplyLowRiskConfiguration:true}));assert.equal(h.framework.service.get(h.session.id,old.id).autoApplyAt,undefined);
  const fresh=await h.framework.propose(h.session.id,{protocolVersion:3,capabilityId:'connector.enable',values:{connectorId:'uniprot'}});assert.equal(fresh.autoApplyAt,undefined);
});
test('CFG-X10c: concurrent policy changes invalidate consent; refusal and Stop do not overwrite them',async context=>{
  const h=await harness(context),card=await h.propose({autoApplyLowRiskConfiguration:true});await h.consent(card);await h.store.updateSession(h.session.id,{autoApplyLowRiskConfiguration:true});await assert.rejects(h.framework.decide(h.session.id,card.id,h.approval(card)),{code:'RESOURCE_VERSION_CONFLICT'});
  const refreshed=await h.framework.preview(h.session.id,card.id,{expectedRevision:card.revision,values:{autoApplyLowRiskConfiguration:false},selectedOptionId:'persist'});assert.equal(refreshed.securityConsent?.status,'required');const declined=await h.framework.preview(h.session.id,card.id,{expectedRevision:refreshed.revision,values:{},selectedOptionId:'dismiss'});await h.framework.decide(h.session.id,card.id,{...h.approval(declined),decision:'dismiss',selectedOptionId:'dismiss'});
  const stopped=await h.propose({autoApplyLowRiskConfiguration:false});await h.consent(stopped);h.store.notifications.stop(h.session.id);await assert.rejects(h.framework.decide(h.session.id,stopped.id,h.approval(stopped)));assert.equal(h.store.getSession(h.session.id)?.autoApplyLowRiskConfiguration,true);
});
test('CFG-X10c: receipt failure rolls flag and legacy/generic countdown withdrawal back together',async context=>{
  const h=await harness(context);await h.save(await h.propose({autoApplyLowRiskConfiguration:true}));const run=await h.store.createSessionRun({sessionId:h.session.id,prompt:'Owned rollback fixture',settingsSnapshot:h.store.resolveRuntimeSettings(h.session.id).effective});const old=await h.framework.propose(h.session.id,{capabilityId:'connector.enable',values:{connectorId:'pubmed'},runId:run.id});assert.ok(old.autoApplyAt);
  const card=await h.propose({autoApplyLowRiskConfiguration:false});await h.consent(card);const db=h.store.getConfigurationDatabase();db.exec("CREATE TRIGGER reject_automatic_receipt BEFORE INSERT ON configuration_receipts_v2 BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");assert.equal((await h.framework.decide(h.session.id,card.id,h.approval(card))).state,'failed');
  assert.equal(h.store.getSession(h.session.id)?.autoApplyLowRiskConfiguration,true);assert.equal(h.framework.service.get(h.session.id,old.id).autoApplyAt,old.autoApplyAt);assert.equal(h.store.getConnectorConfigurationRequest(h.session.id,old.id)?.autoApplyAt,old.autoApplyAt);db.exec('DROP TRIGGER reject_automatic_receipt');
});
