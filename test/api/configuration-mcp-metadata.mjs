// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: edit only a custom MCP name/description through a manually reviewed conversation card.
 * Steps: owned API/MCP fixtures; bounded metadata proposal; save/replay; conflict/refusal; optional browser.
 * Environment: immutable compiled Native API, fresh data, own empty extensions file, two ephemeral loopback ports.
 * Type: actual local MCP discovery fixture; metadata must cause zero additional MCP requests. No real service/model/Runner.
 * Credentials: generated own API token and synthetic fixture keys only; redact all evidence.
 * CostSideEffects: create/delete exact own MCP/provider/Project fixtures, restore own defaults, stop owned processes/browser.
 * Run: E2E_MCP_METADATA_ISOLATED=1 node test/api/configuration-mcp-metadata.mjs
 * Browser: E2E_MCP_METADATA_BROWSER=1 with pinned .e2e Chromium/cache, new context and own-origin browser network guard.
 * Boundary: metadata persistence and authoritative receipt; no live vendor/OAuth/STDIO/Runner/Linux/Jiuwen certification.
 */
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const directory=resolve('.tmp','mcp-metadata-stack-'+randomUUID());await mkdir(directory,{recursive:true});
const startedAt=new Date().toISOString(),token='owned-api-'+randomUUID(),key='synthetic-mcp-'+randomUUID(),steps=[],requests=[],mcpCalls=[];
const redact=value=>[token,key].reduce((text,secret)=>text.replaceAll(secret,'[owned-secret]'),String(value));
let outcome='BLOCKED',sha,origin,mcpOrigin,product,mcpFixture,project,session,provider,server,baseline,browser,context,phase='setup',logs='',baselineCalls=0;
class Blocked extends Error{}
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;}
async function api(path,body,method=body===undefined?'GET':'POST',expected=body===undefined?200:201){const response=await fetch(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+token,'content-type':'application/json','Idempotency-Key':randomUUID()},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();requests.push({method,path,status:response.status,code:value.code});assert.equal(response.status,expected,path+': '+(value.code??response.status));assert.ok(!JSON.stringify(value).includes(key),'Synthetic key escaped public response');return value;}
async function step(name,work){try{await work();steps.push({name,status:'PASS'});}catch(error){steps.push({name,status:error instanceof Blocked?'BLOCKED':'FAIL',error:redact(error.message)});throw error;}}
const path=(card,action)=>'/api/sessions/'+session.id+'/configuration-requests'+(card?'/'+card.id:'')+(action?'/'+action:'');
const propose=values=>api(path(),{protocolVersion:3,capabilityId:'mcp.metadata',values});
const decide=(card,decision='apply')=>api(path(card,'decision'),{revision:card.revision,previewDigest:card.previewDigest,selectedOptionId:card.selectedOptionId,decision},'POST',200);
const current=async()=>{const item=(await api('/api/mcp/servers')).find(item=>item.id===server.id);assert.ok(item);return item;};
const encryptedDigest=async()=>createHash('sha256').update(await readFile(resolve(directory,'data','custom-mcp-servers.enc'))).digest('hex');
const noMetadataCalls=()=>assert.equal(mcpCalls.filter(call=>call.phase==='metadata').length,0);
try{
 await step('1. Start the immutable product with no default MCP servers and discover one owned HTTP fixture',async()=>{
  if(process.env.E2E_MCP_METADATA_ISOLATED!=='1')throw new Blocked('Explicit owned isolation required');sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();if(execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw new Blocked('Commit candidate first');
  const extensions=resolve(directory,'empty-extensions.json');await writeFile(extensions,JSON.stringify({mcpServers:{}}));
  mcpFixture=createServer(async(request,response)=>{let raw='';for await(const part of request)raw+=part;let rpc;try{rpc=JSON.parse(raw);}catch{}
   mcpCalls.push({phase,httpMethod:request.method,path:request.url,rpcMethod:rpc?.method,authorized:request.headers.authorization==='Bearer '+key});
   const send=value=>{response.writeHead(200,{'content-type':'application/json','mcp-session-id':'owned-metadata-session'});response.end(JSON.stringify(value));};
   if(request.method==='DELETE'){response.writeHead(200);response.end();return;}if(request.method!=='POST'){response.writeHead(405);response.end();return;}
   if(rpc?.id===undefined){response.writeHead(202);response.end();return;}
   if(rpc.method==='initialize')send({jsonrpc:'2.0',id:rpc.id,result:{protocolVersion:rpc.params?.protocolVersion??'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'Owned metadata fixture',version:'1'}}});
   else if(rpc.method==='tools/list')send({jsonrpc:'2.0',id:rpc.id,result:{tools:[{name:'owned_echo',description:'Owned read-only fixture',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}});
   else send({jsonrpc:'2.0',id:rpc.id,error:{code:-32601,message:'Unexpected owned fixture operation'}});
  });mcpOrigin='http://127.0.0.1:'+await listen(mcpFixture);
  const reservation=createServer(),port=await listen(reservation);await new Promise(resolve=>reservation.close(resolve));origin='http://127.0.0.1:'+port;
  const env={...process.env,SCIENCE_AGENT_PORT:String(port),SCIENCE_AGENT_AUTH_TOKEN:token,SCIENCE_DISCOVERY_DATA_DIR:resolve(directory,'data'),SCIENCE_AGENT_DATA_DIR:resolve(directory,'data'),SCIENCE_AGENT_SAMPLE_SESSION:'0',SCIENCE_AGENT_EXECUTOR:'native',SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE:'0',SCIENCE_AGENT_MEMORY_GRAPH_URL:'http://127.0.0.1:1',SCIENCE_AGENT_RUNNER_URL:'http://127.0.0.1:1',SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH:extensions};for(const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'])env[name]='';
  product=spawn(process.execPath,['services/api/dist/server.js'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});for(const stream of [product.stdout,product.stderr])stream.on('data',data=>{logs+=redact(data);});let ready=false;const deadline=Date.now()+45000;while(Date.now()<deadline){if(product.exitCode!==null)throw new Blocked('Owned API exited');try{await api('/health');ready=true;break;}catch{}await new Promise(resolve=>setTimeout(resolve,200));}if(!ready)throw new Blocked('Owned API did not become ready');baseline=await api('/api/settings');
  server=await api('/api/mcp/servers',{name:'Owned MCP metadata',description:'Initial metadata',transport:'http',enabled:true,url:mcpOrigin+'/mcp',headers:{Authorization:'Bearer '+key},timeoutSeconds:37});assert.equal(server.status,'ready');assert.ok(server.tools.some(tool=>tool.name==='owned_echo'));assert.ok(mcpCalls.some(call=>call.rpcMethod==='initialize'));assert.ok(mcpCalls.some(call=>call.rpcMethod==='tools/list'));assert.ok(mcpCalls.filter(call=>call.httpMethod==='POST').every(call=>call.authorized));
  provider=await api('/api/providers',{name:'Owned unused model provider',baseUrl:mcpOrigin+'/unused-model/v1',apiToken:key});await api('/api/providers/'+provider.id+'/models',{model:'owned-unused',setGlobalDefault:false});project=await api('/api/projects',{name:'MCP metadata '+randomUUID()});session=await api('/api/projects/'+project.id+'/sessions',{title:'Owned MCP metadata'});baselineCalls=mcpCalls.length;phase='metadata';
 });outcome='FAIL';let card;
 await step('2. Review finite metadata, rejecting transport/secret fields and leaving the authority unchanged before confirmation',async()=>{
  for(const values of [{serverId:server.id,command:'forbidden'},{serverId:server.id,enabled:false},{serverId:server.id,apiToken:key}])assert.equal((await api(path(),{protocolVersion:3,capabilityId:'mcp.metadata',values},'POST',400)).code,'INVALID_CONFIGURATION_INPUT');
  card=await propose({serverId:server.id,name:'Renamed owned MCP',description:'Updated metadata'});assert.equal(card.scope.kind,'global');assert.equal(card.verificationPlan.maxRequests,0);assert.equal((await current()).name,server.name);assert.equal(card.fields.some(field=>field.kind==='credential'),false);noMetadataCalls();
 });
 await step('3. Manual save/replay retain the discovered tools, connection, masked headers, enabled state and timeout without reconnecting',async()=>{
  const before=await current(),digestBefore=await encryptedDigest();await decide(card);const saved=await current(),digestSaved=await encryptedDigest();assert.equal(saved.name,'Renamed owned MCP');assert.equal(saved.description,'Updated metadata');for(const field of ['url','transport','enabled','headers','env','timeoutSeconds','authMode','tools','checkedAt','status'])assert.deepEqual(saved[field],before[field]);assert.notEqual(digestSaved,digestBefore);await decide(card);assert.equal(await encryptedDigest(),digestSaved);noMetadataCalls();
 });
 await step('4. An actual concurrent formal edit invalidates the old proposal, and refusal does not overwrite it',async()=>{
  card=await propose({serverId:server.id,description:'Stale description'});phase='formal-edit';const before=await current();await api('/api/mcp/servers/'+server.id,{...before,name:'Changed through formal settings'},'PUT',200);phase='metadata';assert.equal((await api(path(card,'decision'),{revision:card.revision,previewDigest:card.previewDigest,selectedOptionId:card.selectedOptionId,decision:'apply'},'POST',409)).code,'RESOURCE_VERSION_CONFLICT');
  const file=await encryptedDigest();card=await api(path(card,'preview'),{expectedRevision:card.revision,values:{},selectedOptionId:'dismiss'},'POST',200);await decide(card,'dismiss');assert.equal((await current()).name,'Changed through formal settings');assert.equal(await encryptedDigest(),file);noMetadataCalls();
 });
 if(process.env.E2E_MCP_METADATA_BROWSER==='1')await step('5. Browser loads the custom server, reviews long metadata at three viewports and manually saves',async()=>{
  execFileSync(process.execPath,['test/sync-e2e.mjs','--check']);const {chromium}=createRequire(resolve('.e2e/package.json'))('@playwright/test');browser=await chromium.launch({headless:true,channel:'chromium'});context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1});await context.route('**/*',route=>{const url=new URL(route.request().url());return ['http:','https:'].includes(url.protocol)&&url.origin!==origin?route.abort():route.continue();});await context.addInitScript(({token,origin})=>{if(location.origin===origin){localStorage.setItem('sciencediscovery-token',token);localStorage.setItem('sciencediscovery-locale','en');}},{token,origin});
  card=await propose({});const page=await context.newPage();await page.goto(origin+'/projects/'+project.id+'/sessions/'+session.id,{waitUntil:'domcontentloaded'});const panel=page.locator('#configuration-request-'+card.id);await panel.waitFor({state:'visible'});await panel.locator('select[name="serverId"]').selectOption(server.id);await panel.getByRole('button',{name:'Refresh proposed changes',exact:true}).click();const name=panel.locator('input[name="name"]');await name.waitFor({state:'visible'});const expectedName='Owned 自定义 MCP metadata with a readable long shared name';const description='Owned 可核对元数据 description; '.repeat(35);await name.fill(expectedName);await panel.locator('textarea[name="description"]').fill(description);await panel.getByRole('button',{name:'Refresh proposed changes',exact:true}).click();
  const confirm=panel.getByRole('button',{name:'Confirm choice and continue',exact:true}),changes=panel.locator('.configuration-diff');await confirm.waitFor({state:'visible'});
  for(const viewport of [{width:1280,height:800},{width:900,height:650},{width:390,height:844}]){await page.setViewportSize(viewport);await changes.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(directory,'mcp-metadata-diff-'+viewport.width+'x'+viewport.height+'.png'),fullPage:true,animations:'disabled',caret:'hide'});await name.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(directory,'mcp-metadata-fields-'+viewport.width+'x'+viewport.height+'.png'),fullPage:true,animations:'disabled',caret:'hide'});}
  await confirm.click();await panel.waitFor({state:'detached'});assert.equal((await current()).name,expectedName);assert.equal((await current()).description,description.trim());noMetadataCalls();const record=page.locator('.conversation-configuration-record').filter({hasText:'Edit custom MCP metadata'}).last();await record.scrollIntoViewIfNeeded();await record.locator('summary').first().click();await page.screenshot({path:resolve(directory,'mcp-metadata-saved.png'),fullPage:true,animations:'disabled',caret:'hide'});
 });noMetadataCalls();outcome='PASS';
}catch(error){outcome=error instanceof Blocked?'BLOCKED':'FAIL';process.exitCode=1;}
finally{
 await context?.close();await browser?.close();phase='cleanup';try{if(baseline)await api('/api/settings',baseline.overrides,'PUT',200);if(project)await api('/api/projects/'+project.id,{confirmationId:project.id},'DELETE',200);if(provider)await api('/api/providers/'+provider.id,undefined,'DELETE',200);if(server)await api('/api/mcp/servers/'+server.id,undefined,'DELETE',200);}catch{outcome='FAIL';process.exitCode=1;steps.push({name:'Restore/delete exact owned fixtures',status:'FAIL'});}
 if(product&&product.exitCode===null&&product.signalCode===null){product.kill();await Promise.race([new Promise(resolve=>product.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);}if(product&&product.exitCode===null&&product.signalCode===null){outcome='FAIL';process.exitCode=1;}if(mcpFixture)await new Promise(resolve=>{mcpFixture.close(resolve);mcpFixture.closeAllConnections();});
 await writeFile(resolve(directory,'startup.log'),logs);await writeFile(resolve(directory,'report.json'),JSON.stringify({outcome,sha,startedAt,endedAt:new Date().toISOString(),origin,mcpOrigin,config:{executor:'native',extensions:'own empty file',runner:'deliberately unavailable',memoryGraph:false,realKeys:false,realModels:false},ownedFixtures:{projectId:project?.id,sessionId:session?.id,providerId:provider?.id,mcpServerId:server?.id},steps,requests,mcpCalls,baselineCalls,metadataNetworkCalls:mcpCalls.filter(call=>call.phase==='metadata').length,boundary:'Owned MCP fixture discovery is setup only; metadata phase sends no MCP/model/OAuth/STDIO request. No real vendor/Linux/Runner/Jiuwen evidence.',serverExit:{code:product?.exitCode,signal:product?.signalCode,pid:product?.pid}},null,2));await writeFile(resolve(directory,'report.md'),`# MCP metadata: ${outcome}\n\nCommit: ${sha??'unknown'}\n\n${steps.map(step=>'- '+step.name+': '+step.status+(step.error?' — '+step.error:'')).join('\n')}\n`);console.log(JSON.stringify({outcome,sha,report:resolve(directory,'report.md')}));
}
