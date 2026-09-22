#!/usr/bin/env node
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

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, globSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collect, execute } from './coordinator.mjs';
import { createPlan, verifyResults, fileDigest, digest } from './plan.mjs';
import { shared, slices, nodeSources, nodeExtraSources, pythonProjects, pythonSources } from './profiles.mjs';
import { preflight } from './environment.mjs';
import { checks } from './checks.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const json=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
const subplan=(plan,entries)=>{const {digest:old,...data}=plan;const value={...data,entries};return {...value,digest:digest(value)};};
function run(command,args,env,log,cwd=root) {
  return new Promise((done,reject)=>{
    const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});
    let output='';
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
    child.on('error',reject);child.on('close',code=>{writeFileSync(log,output);done(code??1);});
  });
}
function python(project){return join(root,'services',project,'.venv/bin/python');}
function projectEnv(env,project){return {...env,PYTHONPATH:[join(root,'services',project,'tests'),join(root,'services',project,'src')].join(':')};}
export async function main(args=process.argv.slice(2)) {
  const action=args.shift()??'run';let slice='shared',output;
  while(args.length){const flag=args.shift();if(flag==='--slice')slice=args.shift();else if(flag==='--output')output=args.shift();else throw new Error(`Unknown option ${flag}`);}
  if(!['run','list','prepare'].includes(action)||!(slice in slices))throw new Error('Usage: test:shared [--slice ut|st|e2e] [--output DIR]');
  // Under CI the layer entry point owns `<CI_RESULTS_DIR>/<layer>/run.log` and
  // its own summary; the frozen plan and its evidence go beside them, not over them.
  const outputDir=resolve(output??(process.env.CI_RESULTS_DIR?join(process.env.CI_RESULTS_DIR,slice,'tagged'):join(root,'.test-runs',slice)));
  mkdirSync(outputDir,{recursive:true});
  // Caches and run data are kept inside the workspace; TMPDIR deliberately is
  // not. The Runner builds its egress socket under it, and a Unix socket path
  // is limited to 107 bytes — a checkout even moderately deep under $HOME puts
  // `<root>/.tmp/tmp/sciencediscovery-egress-XXXXXX/egress.sock` over that, and
  // the sandbox network tests fail on the path length rather than on anything
  // they assert. The system temporary directory is what these suites used
  // before they were planned, and it is what they keep.
  const env={...process.env,CI:'1',UV_CACHE_DIR:join(root,'.tmp/cache/uv'),
    UV_PYTHON_INSTALL_DIR:join(root,'.tmp/python'),npm_config_cache:join(root,'.tmp/cache/npm'),
    PLAYWRIGHT_BROWSERS_PATH:join(root,'.e2e/browsers'),CI_RESULTS_DIR:outputDir,
    // The harness self-test needs an interpreter with pytest; the project
    // virtualenvs preparation just built are the ones this revision pins.
    SCIENCE_TEST_PYTHON:python('paper'),
    SCIENCE_DISCOVERY_DATA_DIR:join(outputDir,'runtime'),SCIENCE_AGENT_DATA_DIR:join(outputDir,'runtime')};
  const needUT=['shared','ut'].includes(slice), needPW=['shared','e2e'].includes(slice);
  // The E2E group can split preparation from execution: a host installs
  // everything and hands the workspace over, and this half only runs.
  const prepared=process.env.CI_E2E_PREPARED==='1';
  const prepareOnly=action==='prepare' || process.env.CI_E2E_PREPARE_ONLY==='1';
  if(prepared && process.env.CI_E2E_PREPARE_ONLY==='1')throw new Error('CI_E2E_PREPARE_ONLY and CI_E2E_PREPARED are mutually exclusive');
  if(action!=='list' && !prepared) {
    const steps=[['pnpm',['install','--frozen-lockfile']],['pnpm',['build']]];
    if(needUT)for(const project of pythonProjects)steps.push(['uv',['sync','--project',`services/${project}`,'--locked',...(project==='evolve'?['--extra','test','--extra','candidates']:project==='memory-graph'?['--extra','test']:[])]]);
    if(needPW)steps.push(['node',['test/sync-e2e.mjs','--write']],['npm',['ci','--prefix','.e2e']],['.e2e/node_modules/.bin/playwright',['install','chromium']]);
    for(let i=0;i<steps.length;i++){const [cmd,argv]=steps[i];console.log(`Prepare: ${cmd} ${argv.join(' ')}`);if(await run(cmd,argv,env,join(outputDir,`prepare-${i}.log`)))throw new Error(`PREPARATION_FAILED: inspect ${join(outputDir,`prepare-${i}.log`)}`);}
  }
  if(prepareOnly){console.log(`Prepared ${slice}; no test was collected or executed here.`);return 0;}
  // Source scopes follow workspace layout, never installed capabilities or environment gates.
  const nodeFiles=[...globSync([...nodeSources],{cwd:root}), ...nodeExtraSources].sort();
  const wantedCategory=slice==='shared'?null:slice.startsWith('ut')?'ut':slice;
  const files=nodeFiles.filter(file=>{
    const source=readFileSync(join(root,file),'utf8');
    return !wantedCategory||source.includes(`category:${wantedCategory}`);
  });
  let catalog=[];
  if(files.length)catalog.push(...collect({root,files,outputDir,nodeImports:['tsx'],env}));
  if(needUT)for(const project of pythonProjects){
    const dir=join(outputDir,`collect-${project}`);mkdirSync(dir,{recursive:true});
    const sources=[...globSync(pythonSources(project),{cwd:root})].sort();
    catalog.push(...collect({root,files:sources,outputDir:dir,python:python(project),env:projectEnv(env,project)}));
  }
  if(needPW){
    const destination=join(outputDir,'playwright-catalog.json');rmSync(destination,{force:true});
    const code=await run('.e2e/node_modules/.bin/playwright',['test','--config','.e2e/playwright.config.ts','--list','--reporter','./test/support/tagged/playwright-reporter.mjs'],{...env,SCIENCE_TAG_PW_CATALOG:destination},join(outputDir,'playwright-collect.log'));
    if(code||!existsSync(destination))throw new Error('PLAYWRIGHT_COLLECTION_FAILED');
    catalog.push(...JSON.parse(readFileSync(destination)).catalog);
  }
  if(needUT)catalog.push(...checks.map(check=>({...check,source:'test/support/tagged/checks.mjs',sourceHash:fileDigest(readFileSync(join(root,'test/support/tagged/checks.mjs'))),runner:'command'})));
  // Explicit opt-in entry points are discoverable metadata, never executed by this policy.
  for(const source of ['test/api/agent_loop_real_smoke.ts','services/runner/workloads/npu-smoke-test.py']){
    const text=readFileSync(join(root,source),'utf8');catalog.push({id:`command:${source}`,source,sourceHash:fileDigest(text),runner:'command',tags:JSON.parse(text.match(/science-tags: (\[[^\n]+\])/)[1])});
  }
  const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim();
  const selector=shared.selector+(slices[slice]?` and (${slices[slice]})`:'');
  const plan=createPlan(catalog,{revision,selector,targets:shared.targets});
  json(join(outputDir,'catalog.json'),catalog);json(join(outputDir,'plan.json'),plan);
  console.log(`Frozen ${plan.entries.length} identities for slice ${slice}; selector=${selector}`);
  console.log(`digest=${plan.digest}; plan=${join(outputDir,'plan.json')}`);
  if(action==='list')return 0;
  const checked=await preflight(plan);
  const requireSandbox=plan.entries.some(e=>e.tags.includes('sandbox:bubblewrap'));
  if(requireSandbox && spawnSync('bwrap',['--ro-bind','/','/','--dev','/dev','true'],{env,encoding:'utf8'}).status!==0)checked.problems.push({code:'BUBBLEWRAP_UNAVAILABLE'});
  if(plan.entries.some(e=>e.tags.includes('category:ut')) && process.getuid?.()===0)checked.problems.push({code:'NON_ROOT_REQUIRED'});
  checked.ok=!checked.problems.length;json(join(outputDir,'preflight.json'),checked);
  const results=[], errors=checked.problems.map(p=>JSON.stringify(p));
  if(checked.ok){
    const groups=new Map();
    for(const e of plan.entries.filter(e=>['node','python'].includes(e.runner))){
      const group=e.runner==='python'?e.source.split('/').slice(0,2).join('/'):e.source;
      const entries=groups.get(group)??[];entries.push(e);groups.set(group,entries);
    }
    let index=0;
    for(const [group,entries] of groups){
      const project=entries[0].runner==='python'?group.split('/')[1]:null;
      const parts=group.split('/');const cwd=['packages','services','apps'].includes(parts[0])?join(root,...parts.slice(0,2)):root;
      const directory=join(outputDir,`group-${++index}`);
      console.log(`Run ${index}/${groups.size}: ${group} (${entries.length})`);
      const summary=await execute({root,cwd,plan:subplan(plan,entries),outputDir:directory,
        python:project?python(project):undefined,nodeImports:['tsx'],env:project?projectEnv(env,project):env,timeoutMs:600_000});
      results.push(...summary.results);errors.push(...summary.problems);
    }
    for(const entry of plan.entries.filter(e=>e.runner==='command')){
      const [command,...argv]=entry.command;const code=await run(command,argv,env,join(outputDir,entry.id.replaceAll(':','-')+'.log'));
      results.push({key:entry.key,outcome:code?'FAIL':'PASS',actualTarget:entry.target});
    }
    const journeys=plan.entries.filter(e=>e.runner==='playwright');
    if(journeys.length){
      const report=join(outputDir,'playwright-results.json');rmSync(report,{force:true});
      // run-e2e.sh keeps writing its stack log, journey reports and Playwright
      // output where every reader already looks for them — `<results>/e2e/` —
      // while the frozen plan and its accounting stay in this slice's own
      // directory beside them.
      const code=await run('bash',['.ci/run-e2e.sh'],{...env,CI_E2E_PREPARED:'1',CI_E2E_BROWSERS_DIR:env.PLAYWRIGHT_BROWSERS_PATH,
        CI_RESULTS_DIR:process.env.CI_RESULTS_DIR?resolve(process.env.CI_RESULTS_DIR):outputDir,
        CI_RUNTIME_DIR:process.env.CI_RUNTIME_DIR??join(outputDir,'e2e-runtime'),
        SCIENCE_TAG_PLAN:join(outputDir,'plan.json'),SCIENCE_TAG_PW_REPORT:report,
        E2E_SCIENTIFIC_ENVS:'1'},join(outputDir,'e2e-driver.log'));
      if(code)errors.push(`PLAYWRIGHT_WORKER_FAILED: ${code}`);
      if(existsSync(report)){const data=JSON.parse(readFileSync(report));results.push(...data.results);errors.push(...data.errors);}else errors.push('PLAYWRIGHT_REPORT_MISSING');
    }
  }
  const summary=verifyResults(plan,results,errors);json(join(outputDir,'summary.json'),summary);
  console.log(JSON.stringify({status:summary.status,planned:summary.planned,executed:summary.executed,passed:summary.passed,failed:summary.failed,skipped:summary.skipped,outputDir}));
  return summary.exitCode;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().then(code=>{process.exitCode=code;}).catch(e=>{console.error(e.stack);process.exitCode=1;});
