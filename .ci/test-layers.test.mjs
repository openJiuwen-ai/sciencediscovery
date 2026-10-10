// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTest } from '../test/support/tagged/compat.mjs';
import { createPlan, verifyResults, subplan } from '../test/support/tagged/plan.mjs';
import { profiles } from '../test/support/tagged/profiles.mjs';
import { preflight } from '../test/support/tagged/environment.mjs';
import { realShards } from '../test/support/tagged/execution.mjs';
import { route, gate } from './tier-policy.mjs';
import { qualityProblems, reconcile } from './real-report.mjs';
import { reserveRequest, settleRequest, realApiProxy } from '../test/helpers/real-api-budget.mjs';
import { createServer } from 'node:http';
const { test }=createTest(import.meta.url,{tags:['category:ut','os:linux','arch:amd64']});
const target={os:'linux',arch:'amd64'};
const descriptor=(id,tier,extra=[])=>({id,source:'test/basic.spec.ts',sourceHash:'a'.repeat(64),runner:'playwright',tags:['category:e2e','os:linux','arch:amd64','model:real',`tier:${tier}`,...extra]});
const plan=(backend='jiuwenswarm')=>createPlan([descriptor('short','l3'),descriptor('judge','l4',['judge:llm']),descriptor('release','l5')],
  {revision:'candidate',profile:'release',selector:profiles.release.selector,targets:[target],execution:{backend,model:'generator',judge:'judge'}});
const passed=e=>({key:e.key,outcome:'PASS',actualTarget:e.target,actualBackend:e.backend});
function directory(t){const path=mkdtempSync(join(tmpdir(),'ci-layers-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}

test('PR inputs cannot enable real calls; every merge_group gets L3',()=>{
  for(const input of ['pr','merge','daily','release']) {
    assert.equal(route('pull_request',input).profile,'pr');
    assert.equal(route('merge_group',input).profile,'merge');
  }
  assert.equal(route('schedule','daily').profile,'daily');
  assert.throws(()=>route('workflow_dispatch','unknown'));
  assert.throws(()=>route('pull_request','pr','silently-fallback'));
});

test('aggregate gate rejects failed, missing, skipped and cancelled required jobs',()=>{
  const needs=Object.fromEntries(['l1','ut','st','e2e','real-plan','real-e2e','real-report','binary','docker'].map(n=>[n,{result:'success'}]));
  assert.deepEqual(gate('merge',needs),[]);
  for(const value of ['failure','cancelled','skipped',undefined]) {
    assert.notEqual(gate('merge',{...needs,'real-e2e':{result:value}}).length,0);
  }
  for(const n of ['real-plan','real-e2e','real-report','binary','docker']) needs[n]={result:'skipped'};
  assert.deepEqual(gate('pr',needs),[]);
  assert.notEqual(gate('merge',needs).length,0);
});

test('backend changes execution identity but never selects a different case',()=>{
  const a=plan(),b=plan('legacy');
  assert.deepEqual(a.entries.map(e=>e.id),b.entries.map(e=>e.id));
  assert.notEqual(a.digest,b.digest);
  assert.equal(verifyResults(a,a.entries.map(passed)).exitCode,0);
  assert.equal(verifyResults(a,a.entries.map(e=>({...passed(e),actualBackend:'legacy'}))).passed,0);
  assert.equal(verifyResults(a,b.entries.map(passed)).exitCode,1);
});

test('quarantined release obligations freeze and fail preflight instead of disappearing',async()=>{
  const p=createPlan([descriptor('blocked','l5',['status:quarantined'])],{revision:'test',selector:profiles.release.selector,targets:[target]});
  assert.equal(p.entries.length,1);
  assert.ok((await preflight(p,{platform:'linux',arch:'x64',env:{}})).problems.some(p=>p.code==='QUARANTINED_REQUIRED_CASE'));
});

test('real shard union is exact and missing worker evidence fails suite accounting',t=>{
  const raw=plan();const p=subplan({...raw,profile:'daily'},raw.entries),root=directory(t);
  const shards=realShards(p);
  assert.deepEqual(shards.flatMap(s=>s.keys).sort(),p.entries.map(e=>e.key).sort());
  for(const shard of shards) {
    const dir=join(root,`real-e2e-results-${shard.name}`,'e2e-real/tagged');mkdirSync(dir,{recursive:true});
    const worker=subplan(p,p.entries.filter(e=>shard.keys.includes(e.key)));
    writeFileSync(join(dir,'plan.json'),JSON.stringify(worker));
    writeFileSync(join(dir,'summary.json'),JSON.stringify(verifyResults(worker,worker.entries.map(passed))));
  }
  const daily={...p,profile:'daily'};delete daily.digest;
  // Re-freeze with the same entries so this isolates accounting from quality.
  const dailyPlan=subplan(daily,p.entries);
  assert.equal(reconcile(dailyPlan,root,{}).exitCode,0);
  const file=join(root,`real-e2e-results-${shards[0].name}`,'e2e-real/tagged/plan.json');
  const before=JSON.parse(readFileSync(file));
  const drift=subplan(before,before.entries.map(e=>({...e,sourceHash:'b'.repeat(64)})));
  writeFileSync(file,JSON.stringify(drift));
  writeFileSync(join(file,'../summary.json'),JSON.stringify(verifyResults(drift,drift.entries.map(passed))));
  assert.ok(reconcile(dailyPlan,root,{}).problems.some(p=>p.includes('SHARD_IDENTITY_MISMATCH')));
  rmSync(join(root,`real-e2e-results-${shards[0].name}`),{recursive:true});
  assert.equal(reconcile(dailyPlan,root,{}).exitCode,1);
});

test('release quality requires calibrated comparable evidence and per-case regression bounds',()=>{
  const original=plan();const p=subplan({...original,evaluatorRevision:'pinned'},original.entries),judged=p.entries.find(e=>e.id==='judge');
  const rows=new Map([[judged.key,{evaluation:{status:'scored',score:80}}]]);
  const baseline={status:'calibrated',reference:'previous-release',evaluatorRevision:'pinned',execution:p.execution,
    cases:{judge:[{path:'evaluation.score',statusPath:'evaluation.status',acceptedStatuses:['scored'],minimum:70,reference:82,maxDrop:3}]}};
  assert.deepEqual(qualityProblems(p,rows,baseline),[]);
  for(const metrics of [{evaluation:{status:'scored',score:78}},{evaluation:{status:'error',score:90}},{evaluation:{status:'scored',score:null}}]) {
    assert.ok(qualityProblems(p,new Map([[judged.key,metrics]]),baseline).length);
  }
  assert.ok(qualityProblems(p,rows,{}).length);
  assert.ok(qualityProblems(p,new Map(),baseline).length);
  assert.ok(qualityProblems(plan('legacy'),rows,baseline).length);
});

test('basic request budget survives worker restart and counts output reservations',t=>{
  const ledger=join(directory(t),'budget.json');
  for(let i=0;i<20;i++) reserveRequest(ledger,{messages:[{role:'user',content:'hello'}]});
  assert.throws(()=>reserveRequest(ledger,{messages:[]}),/BUDGET_EXHAUSTED/);
  assert.equal(JSON.parse(readFileSync(ledger)).reservedOutputTokens,20_000);
});

test('reported usage refunds reservations; unknown calls and exhausted request count never reset',t=>{
  const ledger=join(directory(t),'budget.json');
  for(let i=0;i<24;i++) {
    const reservation=reserveRequest(ledger,{messages:[{role:'user',content:'hi'}]});
    settleRequest(ledger,reservation,{prompt_tokens:10,completion_tokens:3});
  }
  const used=JSON.parse(readFileSync(ledger));
  assert.equal(used.reservedInputTokens,240);assert.equal(used.reservedOutputTokens,72);assert.equal(used.unreportedCalls,0);
  assert.throws(()=>reserveRequest(ledger,{messages:[]}),/BUDGET_EXHAUSTED/);
});

test('real pass-through forwards a bounded real request and does not expose the provider key',async t=>{
  let received;
  const upstream=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;received={body:JSON.parse(body),authorization:req.headers.authorization};res.setHeader('content-type','application/json');res.end('{"choices":[{"message":{"content":"real response"}}]}');});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>upstream.close(resolve)));
  const proxy=await realApiProxy({baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,token:'upstream-only',ledger:join(directory(t),'ledger.json')});
  t.after(()=>proxy.stop());
  const response=await fetch(`${proxy.baseUrl}/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${proxy.token}`},body:JSON.stringify({messages:[{role:'user',content:'hi'}],max_tokens:99999})});
  assert.equal(response.status,200);assert.match(await response.text(),/real response/);
  assert.equal(received.authorization,'Bearer upstream-only');assert.equal(received.body.max_tokens,1024);
  assert.notEqual(proxy.token,'upstream-only');
});

test('streamed usage settles the request reservation across transport chunks',async t=>{
  const upstream=createServer(async(req,res)=>{
    for await(const _ of req) { /* consume request */ }
    res.setHeader('content-type','text/event-stream');
    res.write('data: {"choices":[],"usage":{"prompt_');
    res.end('tokens":20,"completion_tokens":4}}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>upstream.close(resolve)));
  const ledger=join(directory(t),'ledger.json');
  const proxy=await realApiProxy({baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,token:'test',ledger});
  t.after(()=>proxy.stop());
  const response=await fetch(`${proxy.baseUrl}/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${proxy.token}`},body:JSON.stringify({messages:[{role:'user',content:'hello'}],stream:true})});
  assert.match(await response.text(),/\[DONE\]/);
  const saved=JSON.parse(readFileSync(ledger));
  assert.equal(saved.reservedInputTokens,20);assert.equal(saved.reservedOutputTokens,4);assert.equal(saved.unreportedCalls,0);
});
