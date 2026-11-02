// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: independently authorize automatic low-risk configuration in this Session.
 * Steps: owned product; independent consent; flag-only save/replay; refusal; CAS; optional browser.
 * Environment: fresh isolated data and ephemeral loopback API port, Native product, unavailable Runner/MemoryGraph.
 * Type: no model or external service; no research, packages or paid calls.
 * Credentials: generated owned API token only, redacted from evidence.
 * CostSideEffects: restore own settings, delete exact owned Project, stop own process/browser.
 * Run: E2E_AUTOMATIC_CONFIGURATION_ISOLATED=1 node test/api/configuration-automatic-configuration.mjs
 * Browser: E2E_AUTOMATIC_CONFIGURATION_BROWSER=1, pinned .e2e Playwright/Chromium.
 * Boundary: saved Session policy; actual legacy countdown rejection is covered separately; no real tool/model.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const directory = resolve(".tmp", `automatic-configuration-stack-${randomUUID()}`); await mkdir(directory, { recursive: true });
const token = `owned-${randomUUID()}`, steps = [], requests = [];
let outcome = "BLOCKED", sha, origin, product, project, session, other, baseline, browser, context, logs = "";
class Blocked extends Error {}
async function api(path, body, method = body === undefined ? "GET" : "POST", expected = body === undefined ? 200 : 201) {
  const response = await fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); requests.push({ method, path, status: response.status, code: value.code }); assert.equal(response.status, expected, `${method} ${path}: ${value.code ?? response.status}`); return value;
}
async function step(name, work) { try { await work(); steps.push({ name, status: "PASS" }); } catch (error) { steps.push({ name, status: error instanceof Blocked ? "BLOCKED" : "FAIL", error: String(error.message).replaceAll(token, "[owned-token]") }); throw error; } }
const formal = () => api("/api/sessions/" + session.id);
const path = (card, action) => `/api/sessions/${session.id}/configuration-requests${card ? `/${card.id}` : ""}${action ? `/${action}` : ""}`;
const propose = values => api(path(), { protocolVersion: 3, capabilityId: "security.automatic_configuration", values });
const consent = card => api(path(card, "security-consent"), { revision: card.revision, targetDigest: card.securityConsent.targetDigest, acknowledged: true }, "POST", 200);
const save = async card => { await consent(card); return decide(card); };
const decide = (card, decision = "apply") => api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: card.selectedOptionId, decision }, "POST", 200);
try {
  await step("1. Start a clean committed product with an owned Project and Session", async () => {
    if (process.env.E2E_AUTOMATIC_CONFIGURATION_ISOLATED !== "1") throw new Blocked("Explicit owned isolation required");
    sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()) throw new Blocked("Commit candidate first");
    const reservation = createServer(); await new Promise(done => reservation.listen(0, "127.0.0.1", done)); const port = reservation.address().port; await new Promise(done => reservation.close(done)); origin = `http://127.0.0.1:${port}`;
    const env = { ...process.env, SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: String(port), SCIENCE_AGENT_AUTH_TOKEN: token,
      SCIENCE_AGENT_DATA_DIR: resolve(directory, "data"), SCIENCE_DISCOVERY_DATA_DIR: resolve(directory, "data"), SCIENCE_AGENT_SAMPLE_SESSION: "0", SCIENCE_AGENT_EXECUTOR: "native", SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "0", SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:1", SCIENCE_AGENT_RUNNER_URL: "http://127.0.0.1:1" };
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) env[key] = "";
    product = spawn(process.execPath, ["services/api/dist/server.js"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [product.stdout, product.stderr]) stream.on("data", data => { logs += String(data).replaceAll(token, "[owned-token]"); });
    let ready = false; const deadline = Date.now() + 45000;
    while (Date.now() < deadline) { if (product.exitCode !== null) throw new Blocked("Product exited"); try { await api("/health"); ready = true; break; } catch {} await new Promise(done => setTimeout(done, 200)); }
    if (!ready) throw new Blocked("Owned API did not become ready");
    project = await api("/api/projects", { name: `Automatic configuration ${randomUUID()}` }); session = await api(`/api/projects/${project.id}/sessions`, { title: "Owned automatic configuration" }); other = await api(`/api/projects/${project.id}/sessions`, { title: "Other owned Session" }); baseline = await formal();
  });
  outcome='FAIL'; let card;
  await step('2. Ordinary Apply and Agent acknowledgement cannot authorize automatic configuration',async()=>{
    await api(path(),{protocolVersion:3,capabilityId:'security.automatic_configuration',values:{autoApplyLowRiskConfiguration:true,acknowledged:true}},'POST',400);
    card=await propose({autoApplyLowRiskConfiguration:true});assert.equal(card.scope.kind,'session');assert.equal(card.securityConsent.status,'required');assert.equal(card.autoApplyAt,undefined);
    const denied=await api(path(card,'decision'),{revision:card.revision,previewDigest:card.previewDigest,selectedOptionId:card.selectedOptionId,decision:'apply'},'POST',409);assert.equal(denied.code,'SECURITY_CONSENT_REQUIRED');assert.equal((await formal()).autoApplyLowRiskConfiguration,false);
  });
  await step('3. Separate consent plus manual save/replay changes only this Session policy',async()=>{
    const saved=await save(card);assert.equal(saved.state,'applied');assert.equal(saved.activation.mode,'next_request');assert.equal(saved.activation.state,'needs_user_action');await decide(card);
    const value=await formal();assert.equal(value.autoApplyLowRiskConfiguration,true);assert.equal(value.approvalMode,baseline.approvalMode);assert.equal(value.permissionEpochId,baseline.permissionEpochId);assert.equal((await api('/api/sessions/'+other.id)).autoApplyLowRiskConfiguration,false);
  });
  await step('4. Refusing a disabling proposal preserves the current policy',async()=>{
    let refused=await propose({autoApplyLowRiskConfiguration:false});refused=await api(path(refused,'preview'),{expectedRevision:refused.revision,values:{},selectedOptionId:'dismiss'},'POST',200);await decide(refused,'dismiss');assert.equal((await formal()).autoApplyLowRiskConfiguration,true);
  });
  await step('5. A concurrent formal policy edit invalidates consent and requires an independently approved new preview',async()=>{
    card=await propose({autoApplyLowRiskConfiguration:false});await consent(card);await api('/api/sessions/'+session.id,{autoApplyLowRiskConfiguration:false},'PATCH',200);
    const stale=await api(path(card,'decision'),{revision:card.revision,previewDigest:card.previewDigest,selectedOptionId:card.selectedOptionId,decision:'apply'},'POST',409);assert.equal(stale.code,'RESOURCE_VERSION_CONFLICT');
    card=await api(path(card,'preview'),{expectedRevision:card.revision,values:{autoApplyLowRiskConfiguration:true},selectedOptionId:'persist'},'POST',200);assert.equal(card.securityConsent.status,'required');
    card=await api(path(card,'preview'),{expectedRevision:card.revision,values:{},selectedOptionId:'dismiss'},'POST',200);await decide(card,'dismiss');assert.equal((await formal()).autoApplyLowRiskConfiguration,false);
  });
  if(process.env.E2E_AUTOMATIC_CONFIGURATION_BROWSER==='1')await step('6. A new browser independently acknowledges and manually saves the low-risk configuration policy',async()=>{
    execFileSync(process.execPath,['test/sync-e2e.mjs','--check']);const {chromium}=createRequire(resolve('.e2e/package.json'))('@playwright/test');browser=await chromium.launch({headless:true,channel:'chromium'});context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1});
    await context.route('**/*',route=>{const url=new URL(route.request().url());return ['http:','https:'].includes(url.protocol)&&url.origin!==origin?route.abort():route.continue();});await context.addInitScript(({token,origin})=>{if(location.origin===origin){localStorage.setItem('sciencediscovery-token',token);localStorage.setItem('sciencediscovery-locale','en');}},{token,origin});
    card=await propose({});const page=await context.newPage();await page.goto(origin+'/projects/'+project.id+'/sessions/'+session.id,{waitUntil:'domcontentloaded'});const panel=page.locator('#configuration-request-'+card.id);await panel.waitFor({state:'visible'});const control=panel.locator('input[name="autoApplyLowRiskConfiguration"]');await control.check();
    await panel.getByRole('button',{name:'Refresh proposed changes',exact:true}).click();const confirm=panel.getByRole('button',{name:'Confirm choice and continue',exact:true});await confirm.waitFor({state:'visible'});assert.equal(await confirm.isDisabled(),true);
    const independent=panel.getByRole('button',{name:'Independently approve this exact security policy',exact:true});assert.equal(await independent.isDisabled(),true);await panel.locator('.configuration-security-ack input').check();await independent.click();
    for(const viewport of [{width:1280,height:800},{width:900,height:650},{width:390,height:844}]){
      await page.setViewportSize(viewport);await control.scrollIntoViewIfNeeded();const inspect=()=>control.evaluate(element=>{const box=element.getBoundingClientRect(),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return {reachable:box.x>=-1&&box.right<=innerWidth+1&&box.y>=-1&&box.bottom<=innerHeight+1&&(hit===element||element.contains(hit)),hit:hit?.className};});let state=await inspect();const deadline=Date.now()+2000;while(!state.reachable&&Date.now()<deadline){await page.waitForTimeout(100);state=await inspect();}
      await page.screenshot({path:resolve(directory,'automatic-'+viewport.width+'x'+viewport.height+'.png'),fullPage:true,animations:'disabled',caret:'hide'});assert.equal(state.reachable,true,JSON.stringify(state));
    }
    await confirm.click();await panel.waitFor({state:'detached'});const saved=await formal();assert.equal(saved.autoApplyLowRiskConfiguration,true);assert.equal(saved.approvalMode,baseline.approvalMode);assert.equal(saved.permissionEpochId,baseline.permissionEpochId);assert.equal((await api('/api/sessions/'+other.id)).autoApplyLowRiskConfiguration,false);
    const record=page.locator('.conversation-configuration-record').filter({hasText:'Authorize low-risk configuration automation'}).last(),summary=record.locator('summary').first();assert.match(await summary.innerText(),/Saved/);await summary.click();await record.getByText('Saved',{exact:true}).first().scrollIntoViewIfNeeded();assert.match(await record.innerText(),/Saved for subsequent requests/);await page.screenshot({path:resolve(directory,'automatic-saved.png'),fullPage:true,animations:'disabled',caret:'hide'});
  }); outcome='PASS';
} catch (error) { outcome = error instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  await context?.close(); await browser?.close();
  try { if (baseline) await api("/api/sessions/" + session.id, { autoApplyLowRiskConfiguration: baseline.autoApplyLowRiskConfiguration === true }, "PATCH", 200); if (project) await api(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE", 200); }
  catch { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Restore exact owned fixtures", status: "FAIL" }); }
  if (product && product.exitCode === null && product.signalCode === null) { product.kill(); await Promise.race([new Promise(done => product.once("exit", done)), new Promise(done => setTimeout(done, 5000))]); }
  if (product && product.exitCode === null && product.signalCode === null) { outcome = "FAIL"; process.exitCode = 1; }
  await writeFile(resolve(directory, "startup.log"), logs); await writeFile(resolve(directory, "report.json"), JSON.stringify({ outcome, sha, steps, requests, boundary: "No actual scientific research or model; Windows isolated API/optional pinned Chromium", serverExit: { code: product?.exitCode, signal: product?.signalCode, pid: product?.pid } }, null, 2));
  await writeFile(resolve(directory, "report.md"), `# Session automatic configuration: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(step => `- ${step.name}: ${step.status}${step.error ? ` — ${step.error}` : ""}`).join("\n")}\n`); console.log(JSON.stringify({ outcome, sha, report: resolve(directory, "report.md") }));
}
