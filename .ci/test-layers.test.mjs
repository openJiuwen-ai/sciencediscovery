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
import { reconcile } from './real-report.mjs';
import { recordRequest, recordUsage, realApiProxy } from '../test/helpers/real-api-proxy.mjs';
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
  const needs=Object.fromEntries(['policy','l1','ut','st','e2e-plan','e2e','real-merge','real-scheduled','binary','docker'].map(n=>[n,{result:'success'}]));
  needs['real-scheduled']={result:'skipped'};
  assert.deepEqual(gate('merge',needs),[]);
  for(const value of ['failure','cancelled','skipped',undefined]) {
    assert.notEqual(gate('merge',{...needs,'real-merge':{result:value}}).length,0);
  }
  for(const n of ['real-merge','real-scheduled','binary','docker']) needs[n]={result:'skipped'};
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

test('existing quarantine stays outside release selection and fails if explicitly selected',async()=>{
  const catalog=[descriptor('eligible','l5'),descriptor('blocked','l5',['status:quarantined'])];
  const options={revision:'test',targets:[target]};
  const p=createPlan(catalog,{...options,selector:profiles.release.selector});
  assert.deepEqual(p.entries.map(e=>e.id),['eligible']);
  const explicit=createPlan([catalog[1]],{...options,selector:'status:quarantined'});
  assert.ok((await preflight(explicit,{platform:'linux',arch:'x64',env:{}})).problems.some(p=>p.code==='QUARANTINED_REQUIRED_CASE'));
});

test('real shard union is exact and missing worker evidence fails suite accounting',t=>{
  const p=plan(),root=directory(t);
  const shards=realShards(p);
  assert.deepEqual(shards.flatMap(s=>s.keys).sort(),p.entries.map(e=>e.key).sort());
  for(const shard of shards) {
    const dir=join(root,`real-e2e-results-${shard.name}`,'e2e-real/tagged');mkdirSync(dir,{recursive:true});
    const worker=subplan(p,p.entries.filter(e=>shard.keys.includes(e.key)));
    writeFileSync(join(dir,'plan.json'),JSON.stringify(worker));
    writeFileSync(join(dir,'summary.json'),JSON.stringify(verifyResults(worker,worker.entries.map(passed))));
  }
  // Release passes on complete existing evidence without a historical baseline.
  assert.equal(reconcile(p,root).exitCode,0);
  const failedSummary=join(root,`real-e2e-results-${shards[0].name}`,'e2e-real/tagged/summary.json');
  const failedWorker=JSON.parse(readFileSync(join(root,`real-e2e-results-${shards[0].name}`,'e2e-real/tagged/plan.json')));
  const failedResults=failedWorker.entries.map((entry,index)=>({...passed(entry),outcome:index===0?'FAIL':'PASS'}));
  writeFileSync(failedSummary,JSON.stringify(verifyResults(failedWorker,failedResults)));
  const failedVerdict=reconcile(p,root);
  assert.equal(failedVerdict.status,'FAIL');
  assert.equal(failedVerdict.executed,p.entries.length);
  assert.equal(failedVerdict.passed,p.entries.length-1);
  assert.equal(failedVerdict.failed,1);
  assert.ok(!failedVerdict.problems.some(problem=>problem.startsWith('NOT_RUN:')));
  writeFileSync(failedSummary,JSON.stringify(verifyResults(failedWorker,failedWorker.entries.map(passed))));
  const file=join(root,`real-e2e-results-${shards[0].name}`,'e2e-real/tagged/plan.json');
  const before=JSON.parse(readFileSync(file));
  const drift=subplan(before,before.entries.map(e=>({...e,sourceHash:'b'.repeat(64)})));
  writeFileSync(file,JSON.stringify(drift));
  writeFileSync(join(file,'../summary.json'),JSON.stringify(verifyResults(drift,drift.entries.map(passed))));
  assert.ok(reconcile(p,root).problems.some(p=>p.includes('SHARD_IDENTITY_MISMATCH')));
  rmSync(join(root,`real-e2e-results-${shards[0].name}`),{recursive:true});
  assert.equal(reconcile(p,root).exitCode,1);
});

test('usage accounting survives restarts without rejecting prior budget thresholds',t=>{
  const ledger=join(directory(t),'usage.json');
  const body={messages:[{role:'user',content:'x'.repeat(320_000)}]};
  for(let i=0;i<30;i++) {
    recordRequest(ledger,body);
    recordUsage(ledger,{prompt_tokens:50_000,completion_tokens:2_000});
  }
  // An interrupted call remains visible without substituting payload bytes for tokens.
  recordRequest(ledger,body);
  recordUsage(ledger,undefined);
  recordUsage(ledger,{prompt_tokens:NaN,completion_tokens:2});
  const used=JSON.parse(readFileSync(ledger));
  assert.equal(used.requests,31);
  assert.equal(used.inputTokens,1_500_000);
  assert.equal(used.outputTokens,60_000);
  assert.equal(used.unreportedCalls,1);
  assert.ok(used.inputBytes>9_000_000);
});

test('real pass-through preserves caller token settings and does not expose the provider key',async t=>{
  let received;
  const upstream=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;received={body:JSON.parse(body),authorization:req.headers.authorization};res.setHeader('content-type','application/json');res.end('{"choices":[{"message":{"content":"real response"}}]}');});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>upstream.close(resolve)));
  const proxy=await realApiProxy({baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,token:'upstream-only',ledger:join(directory(t),'ledger.json')});
  t.after(()=>proxy.stop());
  const response=await fetch(`${proxy.baseUrl}/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${proxy.token}`},body:JSON.stringify({messages:[{role:'user',content:'x'.repeat(320_000)}],max_completion_tokens:4096})});
  assert.equal(response.status,200);assert.match(await response.text(),/real response/);
  assert.equal(received.authorization,'Bearer upstream-only');assert.equal(received.body.max_completion_tokens,4096);
  assert.equal(received.body.max_tokens,undefined);
  assert.notEqual(proxy.token,'upstream-only');
});

test('streamed usage records provider tokens across transport chunks',async t=>{
  const upstream=createServer(async(req,res)=>{
    for await(const _ of req) { /* consume request */ }
    res.setHeader('content-type','text/event-stream');
    res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
    res.write(': keepalive\n\ndata: {"choices":[{"delta":{"content":"pong"},"finish_reason":null}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
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
  assert.equal(saved.inputTokens,20);assert.equal(saved.outputTokens,4);assert.equal(saved.unreportedCalls,0);
  assert.equal(proxy.requests[0].contentDeltas,1);
  assert.deepEqual(proxy.requests[0].finishReasons,['stop']);
});
