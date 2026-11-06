// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// Gated, owned STDIO fixture. Not a standalone journey; no network or secret output.
import { appendFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
const journal=resolve(process.argv[2]??'');
if(process.env.OWNED_MCP_FIXTURE!=='1'||dirname(journal)!==process.cwd()||basename(journal)!=='fixture-events.jsonl')throw new Error('Owned fixture marker/path required');
const presence=()=>({pid:process.pid,tokenPresent:Object.hasOwn(process.env,'OWNED_MCP_TOKEN'),keepPresent:Object.hasOwn(process.env,'OWNED_MCP_KEEP')});
const record=event=>appendFileSync(journal,JSON.stringify({at:new Date().toISOString(),...presence(),...event})+'\n');
record({kind:'start'});
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{
 let rpc;try{rpc=JSON.parse(line);}catch{return;}
 record({kind:'rpc',method:rpc.method});if(rpc.id===undefined){return;}
 let result;
 if(rpc.method==='initialize'){result={protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'Owned environment fixture',version:'1'}};}
 else if(rpc.method==='tools/list'){result={tools:[{name:'owned_env_presence',description:'Return owned variable presence booleans only',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};}
 else if(rpc.method==='tools/call'&&rpc.params.name==='owned_env_presence'){result={content:[{type:'text',text:JSON.stringify(presence())}]};}
 else if(rpc.method==='ping'){result={};}
 else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:rpc.id,error:{code:-32601,message:'Unknown owned fixture method'}})+'\n');return;}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result})+'\n');
});
lines.on('close',()=>process.exit(0));
