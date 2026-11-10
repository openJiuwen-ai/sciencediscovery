// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: configured MCP header credentials never follow HTTP/SSE redirects to another owned origin.
 * Steps: immutable isolated API and two owned HTTP fixtures; configure/test HTTP redirect; SSE redirect; direct final endpoint control.
 * Environment: compiled product API, fresh owned data, empty extensions, three ephemeral loopback ports.
 * Type: actual SDK HTTP/SSE transports through the public formal MCP settings/test API. No external service/model/Runner.
 * Credentials: generated owned API token and synthetic X-Api-Key; record booleans only, redact logs.
 * CostSideEffects: own MCP settings only; delete exact returned IDs, stop own API/fixtures; no user runtime or settings.
 * Run: E2E_MCP_REDIRECT_ISOLATED=1 node test/api/mcp-credential-redirect-boundary.mjs
 * Boundary: no UI modification/browser coverage, no real OAuth/proxy chain/Linux/vendor authentication proof.
 */
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const directory=resolve('.tmp','mcp-redirect-boundary-'+randomUUID());await mkdir(directory,{recursive:true});
const token='owned-api-'+randomUUID(),key='synthetic-owned-'+randomUUID(),steps=[],requests=[],createdIds=[],sourceCalls=[],sinkCalls=[];
const redact=value=>[token,key].reduce((text,secret)=>text.replaceAll(secret,'[owned-secret]'),String(value));
let outcome='BLOCKED',sha,origin,sourceOrigin,sinkOrigin,source,sink,product,logs='',phase='setup';
class Blocked extends Error{}
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;}
async function api(path,body,method=body===undefined?'GET':'POST',expected=body===undefined?200:201){const response=await fetch(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+token,'content-type':'application/json','Idempotency-Key':randomUUID()},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();requests.push({method,path,status:response.status});assert.equal(response.status,expected);assert.ok(!JSON.stringify(value).includes(key));return value;}
async function step(name,action){try{await action();steps.push({name,status:'PASS'});}catch(error){steps.push({name,status:error instanceof Blocked?'BLOCKED':'FAIL',error:redact(error.message)});throw error;}}
try{
 await step('1. Start the committed isolated product and two owned origins using synthetic credentials',async()=>{
  if(process.env.E2E_MCP_REDIRECT_ISOLATED!=='1')throw new Blocked('Explicit owned isolation required');sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();if(execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw new Blocked('Commit target before testing');
  const extensions=resolve(directory,'empty-extensions.json');await writeFile(extensions,JSON.stringify({mcpServers:{}}));
  sink=createServer((request,response)=>{sinkCalls.push({phase,method:request.method,gotKey:request.headers['x-api-key']===key});response.writeHead(403);response.end();});sinkOrigin='http://127.0.0.1:'+await listen(sink);
  source=createServer(async(request,response)=>{sourceCalls.push({phase,path:request.url,method:request.method,gotKey:request.headers['x-api-key']===key});if(request.url?.startsWith('/redirect')){response.writeHead(307,{location:sinkOrigin+'/unconfigured'});response.end();return;}
   if(request.method!=='POST'){response.writeHead(request.method==='DELETE'?200:405);response.end();return;}let raw='';for await(const part of request)raw+=String(part);const rpc=JSON.parse(raw);if(rpc.id===undefined){response.writeHead(202);response.end();return;}
   let result;if(rpc.method==='initialize')result={protocolVersion:rpc.params?.protocolVersion??'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'Owned final endpoint',version:'1'}};else if(rpc.method==='tools/list')result={tools:[{name:'owned_echo',description:'Owned control',inputSchema:{type:'object',properties:{}}}]};else{response.writeHead(400);response.end();return;}response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));});sourceOrigin='http://127.0.0.1:'+await listen(source);
  const reservation=createServer(),port=await listen(reservation);await new Promise(resolve=>reservation.close(resolve));origin='http://127.0.0.1:'+port;
  const env={...process.env,SCIENCE_AGENT_HOST:'127.0.0.1',SCIENCE_AGENT_PORT:String(port),SCIENCE_AGENT_AUTH_TOKEN:token,SCIENCE_DISCOVERY_DATA_DIR:resolve(directory,'data'),SCIENCE_AGENT_DATA_DIR:resolve(directory,'data'),SCIENCE_AGENT_SAMPLE_SESSION:'0',SCIENCE_AGENT_EXECUTOR:'native',SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE:'0',SCIENCE_AGENT_MEMORY_GRAPH_URL:'http://127.0.0.1:1',SCIENCE_AGENT_RUNNER_URL:'http://127.0.0.1:1',SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH:extensions};for(const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'])env[name]='';
  product=spawn(process.execPath,['services/api/dist/server.js'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});for(const stream of [product.stdout,product.stderr])stream.on('data',data=>{logs+=redact(data);});let ready=false;const deadline=Date.now()+45000;while(Date.now()<deadline){if(product.exitCode!==null)throw new Blocked('Owned API exited');try{await api('/health');ready=true;break;}catch{}await new Promise(resolve=>setTimeout(resolve,200));}if(!ready)throw new Blocked('Owned API did not become ready');
 });outcome='FAIL';
 for(const transport of ['http','sse'])await step((transport==='http'?'2. ':'3. ')+'Reject '+transport+' redirect without sending a request or key to the unconfigured origin',async()=>{
  phase=transport+' redirect';const saved=await api('/api/mcp/servers',{name:'Owned '+transport+' redirect',transport,enabled:true,url:sourceOrigin+'/redirect-'+transport,headers:{'X-Api-Key':key},timeoutSeconds:2});createdIds.push(saved.id);assert.equal(saved.status,'error');assert.equal(saved.tools.length,0);const tested=await api('/api/mcp/servers/'+saved.id+'/test',{},'POST',200);assert.equal(tested.status,'error');assert.equal(tested.tools.length,0);assert.ok(tested.error);assert.equal(sinkCalls.length,0);assert.ok(sourceCalls.some(call=>call.phase===phase&&call.gotKey));
 });
 await step('4. Configuring the direct final endpoint still initializes and lists tools with its intended credential',async()=>{
  phase='direct control';const saved=await api('/api/mcp/servers',{name:'Owned direct final endpoint',transport:'http',enabled:true,url:sourceOrigin+'/mcp',headers:{'X-Api-Key':key},timeoutSeconds:2});createdIds.push(saved.id);assert.equal(saved.status,'ready');assert.ok(saved.tools.some(tool=>tool.name==='owned_echo'));const tested=await api('/api/mcp/servers/'+saved.id+'/test',{},'POST',200);assert.equal(tested.status,'ready');assert.ok(tested.tools.some(tool=>tool.name==='owned_echo'));assert.equal(sinkCalls.length,0);assert.ok(sourceCalls.some(call=>call.phase===phase&&call.path==='/mcp'&&call.gotKey));
 });outcome='PASS';
}catch(error){outcome=error instanceof Blocked?'BLOCKED':'FAIL';process.exitCode=1;}
finally{
 phase='cleanup';try{for(const id of createdIds)await api('/api/mcp/servers/'+id,undefined,'DELETE',200);}catch{outcome='FAIL';process.exitCode=1;steps.push({name:'Delete exact owned MCP IDs',status:'FAIL'});}
 if(product&&product.exitCode===null&&product.signalCode===null){product.kill();await Promise.race([new Promise(resolve=>product.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);}if(product&&product.exitCode===null&&product.signalCode===null){outcome='FAIL';process.exitCode=1;}for(const server of [source,sink])if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});if(sinkCalls.length){outcome='FAIL';process.exitCode=1;}
 await writeFile(resolve(directory,'startup.log'),logs);await writeFile(resolve(directory,'report.json'),JSON.stringify({outcome,sha,origin,sourceOrigin,sinkOrigin,steps,requests,createdIds,sourceCalls,sinkCalls,serverExit:{code:product?.exitCode,signal:product?.signalCode,pid:product?.pid},boundary:'Owned HTTP/SSE redirect transport proof through public API; no real key/vendor/OAuth/proxy/Linux/Runner/model or browser proof'},null,2));await writeFile(resolve(directory,'report.md'),'# MCP credential redirect boundary: '+outcome+'\n\nCommit: '+sha+'\n\n'+steps.map(item=>'- '+item.name+': '+item.status+(item.error?' — '+item.error:'')).join('\n')+'\n');console.log(JSON.stringify({outcome,sha,report:resolve(directory,'report.md')}));
}
