// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

process.env.SCIENCE_AGENT_EXECUTOR = 'native';
const realSetTimeout = globalThis.setTimeout;
const realDelay = (ms) => new Promise(resolve => realSetTimeout(resolve,ms));
const liveSteps=[];
async function drainUntil(predicate) {
  for (let i=0;i<500&&!predicate();i++) await realDelay(2);
  assert.ok(predicate(),'production SSE sink reached the expected phase');
}
const terminal = 'full final result\n' + 'FINAL'.repeat(5000);
let cancelledSignal;
const pendingTimers = new Set();
let nativeSetTimeout, nativeClearTimeout;
function trackClockTimers() {
  nativeSetTimeout=globalThis.setTimeout; nativeClearTimeout=globalThis.clearTimeout;
  globalThis.setTimeout=(callback,delay,...args)=>{
    const timer=nativeSetTimeout(()=>{pendingTimers.delete(timer);callback(...args);},delay);
    pendingTimers.add(timer); return timer;
  };
  globalThis.clearTimeout=timer=>{pendingTimers.delete(timer);nativeClearTimeout(timer);};
}
mock.module(new URL('../../src/agent-run/create-agent-run.ts',import.meta.url).href, {namedExports:{
  createAgentRun(profile,bindings,input) {
    return {abort(){},beginExternalWait(){return ()=>{};},async execute(){
      if (profile.kind === 'main') {
        const normal=await bindings.workspace.runSubagent({description:'normal',prompt:'normal'});
        assert.equal(normal.status,'completed');
        const abort=new AbortController(); cancelledSignal=abort;
        const cancelled=await bindings.workspace.runSubagent({description:'cancel',prompt:'cancel'},abort.signal);
        assert.equal(cancelled.status,'cancelled');
        assert.equal(pendingTimers.size,0,'child cancellation/finally clears both broadcast and catalog timers');
        mock.timers.tick(1000); // production finally must have cleared pending progress timers
        mock.timers.reset();
        return {finalMessages:[{role:'assistant',content:'done'}]};
      }
      // Only the adapter is substituted. The observer and publishStep are the
      // actual closures assembled by runs/index.ts, including persistence.
      if (!cancelledSignal) { mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()}); trackClockTimers(); }
      const emit=bindings.observer;
      const offset=liveSteps.length;
      emit({type:'tool_execution_progress',toolCallId:'absent',toolName:'search_pubmed',chunk:'must never appear'});
      emit({type:'tool_execution_start',toolCallId:'tool',toolName:'search_pubmed',args:{query:'CRISPR'}});
      emit({type:'tool_execution_progress',toolCallId:'tool',toolName:'search_pubmed',chunk:'first evidence\n'});
      await drainUntil(()=>liveSteps.length===offset+2);
      assert.equal(liveSteps.at(-1).step.content,'first evidence\n','first transient snapshot is immediate');
      emit({type:'tool_execution_progress',toolCallId:'tool',toolName:'search_pubmed',chunk:'second\n'});
      emit({type:'tool_execution_progress',toolCallId:'tool',toolName:'search_pubmed',chunk:'newest\n'});
      mock.timers.tick(249);
      await realDelay(10);
      assert.equal(liveSteps.length,offset+2,'a burst cannot broadcast before the 250 ms boundary');
      if (cancelledSignal) {
        cancelledSignal.abort(new Error('cancel fixture'));
        throw bindings.abortSignal.reason;
      }
      mock.timers.tick(1); // one trailing snapshot, containing the newest input
      await drainUntil(()=>liveSteps.length===offset+3);
      assert.equal(liveSteps.at(-1).step.content,'first evidence\nsecond\nnewest\n');
      emit({type:'tool_execution_progress',toolCallId:'tool',toolName:'search_pubmed',chunk:'x'.repeat(20000)+'tail evidence'});
      assert.equal(pendingTimers.size,2,'the new burst has catalog and trailing timers');
      emit({type:'tool_execution_end',toolCallId:'tool',toolName:'search_pubmed',isError:false,result:{content:[{type:'text',text:terminal}]}});
      assert.equal(pendingTimers.size,1,'terminal completion cancels the trailing timer immediately');
      mock.timers.tick(500); // Terminal must cancel the pending trailing timer.
      // A delayed adapter packet after terminal completion is not a new phase.
      emit({type:'tool_execution_progress',toolCallId:'tool',toolName:'search_pubmed',chunk:'late packet must never appear'});
      mock.timers.tick(500);
      emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Research complete'}]}});
      return {finalMessages:[{role:'assistant',content:'Research complete'}]};
    }};
  }
}});
const {createApiServer}=await import('../../src/server.js');
const {offlineMcpTransport}=await import('../../src/mcp/offline-transport.fixture.js');
const root=await mkdtemp(join(tmpdir(),'issue330-child-'));
const runner=createServer((_req,res)=>res.end(JSON.stringify({status:'ok',sandbox:'bubblewrap',npuBroker:{enabled:false},scientificEnvs:{available:false},sandboxNetwork:{available:true,modes:['none']}})));
await new Promise(resolve=>runner.listen(0,'127.0.0.1',resolve));
const config={authToken:'fixture',dataDir:root,host:'127.0.0.1',port:0,runnerUrl:`http://127.0.0.1:${runner.address().port}`,runnerToken:'fixture',
  gatewayIdleTimeoutMs:240000,gatewayTurnTimeoutMs:0,kernelIdleTimeoutMs:0,permissionWaitTimeoutMs:0,runnerExecTimeoutMs:0,
  runnerMaxOutputBytes:1000000,runnerMaxWorkspaceBytes:10737418240,modelCatalogPath:join(root,'absent.json'),sshConfigPath:join(root,'ssh'),staticDir:join(root,'absent-web'),
  paperPythonPath:'unused',paperWorkerPath:'unused',workspaceUpload:{maxFileBytes:1000000,maxRequestBytes:10000000,maxWorkspaceBytes:10737418240},
  memoryGraph:{url:'',internalToken:''},evolve:{url:'',internalToken:''}};
const server=createApiServer(config,{mcpTransport:offlineMcpTransport});
server.on('request',(_request,response)=>{
  const write=response.write;
  response.write=function(chunk,...args){
    const text=String(chunk);
    if(text.startsWith('data: ')) {
      const event=JSON.parse(text.slice(6));
      if(event.type==='subagent.step'&&event.step.id==='tool') liveSteps.push(event);
    }
    return write.call(this,chunk,...args);
  };
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const headers={authorization:'Bearer fixture','content-type':'application/json'};
async function request(path,body) {const r=await fetch(origin+path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});assert.ok(r.ok,await r.clone().text());return r;}
try {
  const model=await (await request('/api/models',{apiToken:'fixture',baseUrl:'http://127.0.0.1:1',model:'fixture',name:'Fixture'})).json();
  const project=await (await request('/api/projects',{name:'Child progress'})).json();
  const session=await (await request(`/api/projects/${project.id}/sessions`,{title:'Research',modelId:model.id})).json();
  const response=await request(`/api/sessions/${session.id}/messages`,{content:'Delegate research'});
  const wire=await response.text();
  const events=wire.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
  assert.ok(events.some(e=>e.type==='run.completed'),wire);
  assert.ok(!wire.includes('must never appear'),'absent and nonrunning tool packets never reach subscribers');
  const children=await (await request(`/api/sessions/${session.id}/subagents`)).json();
  assert.equal(children.length,2);
  const normal=children.find(c=>c.input.description==='normal'),cancelled=children.find(c=>c.input.description==='cancel');
  assert.equal(cancelled.status,'cancelled');
  const normalSteps=events.filter(e=>e.type==='subagent.step'&&e.subagentId===normal.id&&e.step.id==='tool').map(e=>e.step);
  assert.equal(normalSteps.length,4,'start, immediate, newest trailing and final only; late/nonrunning packets ignored');
  assert.deepEqual(normalSteps.slice(0,3).map(s=>s.content),['CRISPR','first evidence\n','first evidence\nsecond\nnewest\n']);
  assert.equal(normal.steps.find(s=>s.id==='tool').content,terminal,'late progress cannot replace the terminal catalog result');
  assert.deepEqual(normalSteps.map(s=>s.status),['running','running','running','completed']);
  const completed=normalSteps.at(-1);
  assert.equal(completed.progress.length,16384);
  assert.ok(completed.progress.startsWith('first evidence\n'));
  assert.ok(completed.progress.endsWith('tail evidence'));
  assert.equal(completed.content,terminal,'final results remain full, independently of bounded progress');
  const cancelSteps=events.filter(e=>e.type==='subagent.step'&&e.subagentId===cancelled.id&&e.step.id==='tool').map(e=>e.step);
  assert.deepEqual(cancelSteps.map(s=>s.content),['CRISPR','first evidence\n'],'no trailing snapshot after cancellation');
  const runs=await (await request(`/api/sessions/${session.id}/runs`)).json();
  const persisted=await (await request(`/api/sessions/${session.id}/runs/${runs[0].id}/streams/subagent-${normal.id}/events`)).json();
  const tools=persisted.filter(r=>r.event.type==='subagent.step'&&r.event.step.id==='tool').map(r=>r.event.step);
  assert.deepEqual(tools.map(s=>s.status),['running','completed'],'only start/terminal records persist');
  assert.equal(tools.at(-1).content,terminal);
  console.log(JSON.stringify({normal:normalSteps.map(s=>({status:s.status,contentChars:s.content.length,progressChars:s.progress?.length})),cancelled:cancelSteps.map(s=>s.content),persisted:tools.map(s=>s.status),result:'PASS'}));
} finally {
  mock.timers.reset();
  await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  await new Promise(resolve=>{runner.close(resolve);runner.closeAllConnections();});
  await rm(root,{recursive:true,force:true});
}
