// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
// Optional integration probe using the installed Swarm Python environment:
// SWARM_PYTHON=/path/to/swarm/.venv/bin/python node --import tsx test/fixtures/swarm-tool-heartbeat-probe.mjs
// No paid model requests. Tests actual gateway -> OpenAI SDK -> Swarm Model.stream watchdog.
// A 0.5s idle budget and 1s argument stream exercise the same boundary as the production 60s budget.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startModelGateway} from '../../services/api/src/agent-run/jiuwenswarm-model-gateway.ts';
const controller=new AbortController();
for(const scenario of ['complete','truncated','stall']){
 const streamer=async(_e,_s,_h,_t,_p,signal,callbacks)=>{
  for(let i=0;i<20;i++){
   await new Promise(r=>setTimeout(r,50));
   if(signal.aborted)throw new Error('aborted');
   callbacks.onProgress();
   callbacks.onToolCallDelta({index:0,id:'tool-1',name:'run_shell',arguments:'private-fragment'});
   if(scenario==='stall'){await new Promise(r=>setTimeout(r,1000));signal.throwIfAborted();}
  }
  const tool={id:'tool-1',name:'run_shell',args:{command:'private-command'}};
  return {truncated:scenario==='truncated',assistantMessage:{role:'assistant',content:''},toolCalls:[tool]};
 };
 const g=await startModelGateway({baseUrl:'http://unused',model:'test',apiProtocol:'anthropic-messages'},{maxRetries:0,maxTokens:1000,requestTimeoutMs:10000},controller.signal,streamer);
 try{
  const child=spawn(process.env.SWARM_PYTHON ?? 'python3',[fileURLToPath(new URL('./swarm-tool-heartbeat-probe.py', import.meta.url))],{stdio:['pipe','inherit','inherit'], timeout:30_000});
  child.stdin.end(JSON.stringify({url:g.url,token:g.token,case:scenario}));
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});if(code!==0)throw new Error(`case ${scenario} exit ${code}`);
 }finally{await g.close();}
}
