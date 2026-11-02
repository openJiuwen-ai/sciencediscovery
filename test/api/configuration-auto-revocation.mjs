// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: revoking a Session automatic-configuration policy durably removes old countdowns before re-enabling.
 * Steps: seed owned waiting compatibility records; run committed compiled API; turn off; turn on; restart owned API; verify both Sessions; cleanup.
 * Environment: fresh data, ephemeral loopback port, Native product; no model/Runner/MCP calls.
 * Type: deterministic seeded ready-connector precondition only, not an actual MCP readiness test.
 * Credentials: generated owned API token only; no real credentials.
 * CostSideEffects: mutate/delete only seeded UUID Project/Sessions, start/stop only own process.
 * Run: E2E_AUTO_REVOCATION_ISOLATED=1 node --import tsx test/api/configuration-auto-revocation.mjs
 * Fixture imports construct pre-start records; all outcome assertions use the public compiled product API.
 * Boundary: public policy and countdown persistence; exact automatic admission rejection is covered by the integration regression.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const directory = resolve(".tmp", `auto-revocation-stack-${randomUUID()}`); await mkdir(directory, { recursive: true });
const token = `owned-${randomUUID()}`, steps = [], requests = [], processExits = [];
let outcome = "BLOCKED", origin, sha, product, project, fixtures = [], logs = "";
class Blocked extends Error {}
async function step(name, work) { try { await work(); steps.push({ name, status: "PASS" }); } catch (error) { steps.push({ name, status: error instanceof Blocked ? "BLOCKED" : "FAIL", error: String(error.message).replaceAll(token,"[owned-token]") }); throw error; } }
async function api(path, body, method = body === undefined ? "GET" : "PATCH", expected = 200) {
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15000), redirect: "error", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); requests.push({ method, path, status: response.status, code: value.code }); assert.equal(response.status, expected, `${path}: ${value.code ?? response.status}`); return value;
}
const card = fixture => api(`/api/sessions/${fixture.sessionId}/configuration-requests/${fixture.requestId}`);
async function stop() {
  if (!product) return; if (product.exitCode === null && product.signalCode === null) { product.kill(); await Promise.race([new Promise(done => product.once("exit", done)), new Promise(done => setTimeout(done, 5000))]); }
  processExits.push({ code: product.exitCode, signal: product.signalCode, pid: product.pid }); if (product.exitCode === null && product.signalCode === null) throw new Error("Owned product did not stop"); product = undefined;
}
async function start() {
  const port = new URL(origin).port, env = { ...process.env, SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: port, SCIENCE_AGENT_AUTH_TOKEN: token, SCIENCE_AGENT_DATA_DIR: resolve(directory,"data"), SCIENCE_DISCOVERY_DATA_DIR: resolve(directory,"data"), SCIENCE_AGENT_SAMPLE_SESSION: "0", SCIENCE_AGENT_EXECUTOR: "native", SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "0", SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:1", SCIENCE_AGENT_RUNNER_URL: "http://127.0.0.1:1" };
  for (const key of ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy"]) env[key] = "";
  product = spawn(process.execPath,["services/api/dist/server.js"],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]}); for(const stream of [product.stdout,product.stderr]) stream.on("data",data=>{logs+=String(data).replaceAll(token,"[owned-token]");});
  const deadline=Date.now()+45000; while(Date.now()<deadline){if(product.exitCode!==null)throw new Blocked("Owned product exited");try{await api('/health');return;}catch{}await new Promise(done=>setTimeout(done,200));}throw new Blocked("Owned product not ready");
}
try {
  await step("1. Seed two owned paused compatibility proposals, then start the committed compiled product", async () => {
    if(process.env.E2E_AUTO_REVOCATION_ISOLATED!=="1")throw new Blocked("Explicit owned isolation required");sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();if(execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw new Blocked("Commit candidate first");
    const reservation=createServer();await new Promise(done=>reservation.listen(0,'127.0.0.1',done));const port=reservation.address().port;await new Promise(done=>reservation.close(done));origin=`http://127.0.0.1:${port}`;
    const { SessionStore }=await import('../../services/api/src/store.ts'),{ ConversationalConfigurationFramework }=await import('../../services/api/src/configuration/framework.ts');
    const store=new SessionStore(resolve(directory,'data'));await store.load();try {
      project=await store.createProject('Owned revocation '+randomUUID());const framework=new ConversationalConfigurationFramework(store,{nativeExecutor:true,connector:()=>({name:'Owned fixture PubMed',ready:true})});
      for(let i=0;i<2;i++){
        const session=await store.createSession(project.id,'Owned waiting '+i,{}, {},{allowUnconfiguredModel:true});await store.updateSession(session.id,{autoApplyLowRiskConfiguration:true});
        const run=await store.createSessionRun({sessionId:session.id,prompt:'Owned waiting fixture; do not run retrieval',settingsSnapshot:store.resolveRuntimeSettings(session.id).effective});
        const view=await framework.propose(session.id,{capabilityId:'connector.enable',values:{connectorId:'pubmed'},runId:run.id});assert.ok(view.autoApplyAt);
        const checkpoint={requestId:view.id,history:[{role:'user',content:run.prompt}],stopGeneration:store.notifications.generation(session.id),committedAt:new Date().toISOString()};
        await store.updateSessionRun(session.id,run.id,{status:'blocked',configurationWait:true,configurationCheckpoint:checkpoint});
        const future=new Date(Date.now()+600000).toISOString();
        await store.runConfigurationTransaction(session.id,()=>{
          const record=framework.service.getRecord(session.id,view.id),version=record.view.stateVersion;record.view.autoApplyAt=future;record.view.stateVersion++;framework.repository.save(record,version);
          const companion=store.getConnectorConfigurationRequest(session.id,view.id);companion.autoApplyAt=future;store.getConfigurationDatabase().prepare('UPDATE connector_configuration_requests SET record_json=? WHERE id=?').run(JSON.stringify(companion),view.id);
        });
        fixtures.push({sessionId:session.id,requestId:view.id,runId:run.id,autoApplyAt:future});
      }
    } finally {store.close();}await start();
    for(const fixture of fixtures){const view=await card(fixture);assert.equal(view.state,'awaiting_confirmation');assert.equal(view.autoApplyAt,fixture.autoApplyAt);}
  }); outcome='FAIL';
  await step("2. Turning off withdraws the old countdown through the public Session API",async()=>{
    const fixture=fixtures[0],before=await card(fixture);await api('/api/sessions/'+fixture.sessionId,{autoApplyLowRiskConfiguration:false});const saved=await card(fixture);assert.equal(saved.state,'awaiting_confirmation');assert.equal(saved.autoApplyAt,undefined);assert.ok(saved.stateVersion>before.stateVersion);
  });
  await step("3. Turning on again does not restore old authority or touch the other Session",async()=>{
    await api('/api/sessions/'+fixtures[0].sessionId,{autoApplyLowRiskConfiguration:true});assert.equal((await card(fixtures[0])).autoApplyAt,undefined);assert.equal((await card(fixtures[1])).autoApplyAt,fixtures[1].autoApplyAt);
    const session=await api('/api/sessions/'+fixtures[0].sessionId);assert.equal(session.autoApplyLowRiskConfiguration,true);assert.equal(session.enabledConnectorIds.includes('pubmed'),false);
  });
  await step("4. Restarting only this owned API preserves revocation and both original paused Runs",async()=>{
    await stop();await start();assert.equal((await card(fixtures[0])).autoApplyAt,undefined);
    for(const fixture of fixtures){const run=await api('/api/sessions/'+fixture.sessionId+'/runs/'+fixture.runId);assert.equal(run.status,'blocked');assert.equal(run.configurationWait,true);const session=await api('/api/sessions/'+fixture.sessionId);assert.equal(session.enabledConnectorIds.includes('pubmed'),false);}
  });outcome='PASS';
} catch(error){outcome=error instanceof Blocked?'BLOCKED':'FAIL';process.exitCode=1;}
finally {
  try{if(product&&project)await api('/api/projects/'+project.id,{confirmationId:project.id},'DELETE');}catch{outcome='FAIL';process.exitCode=1;steps.push({name:'Delete exact owned Project',status:'FAIL'});}
  try{await stop();}catch{outcome='FAIL';process.exitCode=1;}
  await writeFile(resolve(directory,'startup.log'),logs);await writeFile(resolve(directory,'report.json'),JSON.stringify({outcome,sha,steps,requests,fixtures,processExits,boundary:'Seeded ready-connector fixture; actual compiled API policy/countdown persistence; no real connector/model/Runner or browser'},null,2));await writeFile(resolve(directory,'report.md'),`# Automatic configuration revocation: ${outcome}\n\nCommit: ${sha??'unknown'}\n\n${steps.map(step=>`- ${step.name}: ${step.status}${step.error?' — '+step.error:''}`).join('\n')}\n`);console.log(JSON.stringify({outcome,sha,report:resolve(directory,'report.md')}));
}
