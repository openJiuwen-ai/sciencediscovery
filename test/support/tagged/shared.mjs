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
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, globSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collect, execute } from './coordinator.mjs';
import { createPlan, verifyResults, fileDigest, subplan } from './plan.mjs';
import { schema } from './tags.mjs';
import { profiles, slices, nodeSources, nodeExtraSources, pythonProjects, pythonSources, pythonPlugins } from './profiles.mjs';
import { preflight } from './environment.mjs';
import { executionConfig, realShards, mockedShards } from './execution.mjs';
import { PROVIDER_FAULT, retryableProviderFaults, providerFaultRepeatFailed, providerFaultRepeatReportMissing } from './provider-fault.mjs';
import { checks } from './checks.mjs';
import { planGroups, schedule, utWorkers, SWARM, SWARM_TAG } from './scheduler.mjs';
import { startSwarm, withoutSwarm } from './swarm.mjs';
import { availableParallelism, totalmem } from 'node:os';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const json=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
// The log always gets the child's output; `echo` also passes it through as it
// arrives, for a step whose progress is what the reader of a job log waits for.
function run(command,args,env,log,cwd=root,{echo=false}={}) {
  return new Promise((done,reject)=>{
    const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});
    let output='';
    child.stdout.on('data',chunk=>{output+=chunk;if(echo)process.stdout.write(chunk);});
    child.stderr.on('data',chunk=>{output+=chunk;if(echo)process.stderr.write(chunk);});
    child.on('error',reject);child.on('close',code=>{writeFileSync(log,output);done(code??1);});
  });
}
function python(project){return join(root,'services',project,'.venv/bin/python');}
function projectEnv(env,project){return {...env,PYTHONPATH:[join(root,'services',project,'tests'),join(root,'services',project,'src')].join(':')};}
/**
 * How many cases are repeated when a whole batch faulted early. A batch that
 * faults as a whole is a gateway outage, not a flaky case: repeating every
 * case in it would re-run the suite against a provider that is already down.
 * A couple of repeats are enough to tell whether the gateway recovered.
 */
const OUTAGE_PROBE_REPEATS=2;
/**
 * Coverage is recorded by the run that gates, never by a second one: `--coverage`
 * instruments exactly this execution and changes nothing about what is selected.
 *
 * Node: each worker keeps its one-file-per-process isolation and adds V8
 * coverage, which the Node processes a test starts inherit. Much of what a test
 * executes arrives through built output — another package's `dist/`, a Runner
 * started from `dist/server.js` — so the run re-emits the build with source
 * maps and those records land on the TypeScript that was written.
 *
 * Python: every interpreter the run starts — the pytest worker, or one a test
 * launches — imports `python/coverage-hook` and measures itself against one
 * set of product roots. Each start is logged with whether it could be measured.
 */
const coverageRequirement='coverage>=7.6,<8';
const pythonRoots=['services/adapter/src','services/evolve/src','services/idea-tree/src','services/gateway/src','services/memory-graph/src','services/paper','services/runner/workloads','skills'];
const coverageHook=join(root,'test/support/tagged/python/coverage-hook');
function coverageSetup(outputDir,coverageDir){
  const data=join(coverageDir,'python-data'),rc=join(outputDir,'coverage.rc');
  mkdirSync(data,{recursive:true});
  writeFileSync(rc,['[run]','branch = True','parallel = True',`data_file = ${join(data,'.coverage')}`,
    'source =',...pythonRoots.map(path=>`    ${join(root,path)}`),
    'omit =','    */tests/*','    */test_*.py','    */.venv/*',
    // A process that runs no product code is the common case, not a warning.
    'disable_warnings =','    no-data-collected','    module-not-measured','    module-not-imported','    couldnt-parse',''].join('\n'));
  const log=join(coverageDir,'python-processes.jsonl');
  return {data,log,env:base=>({...base,COVERAGE_PROCESS_START:rc,SCIENCE_COVERAGE_DATA_DIR:data,SCIENCE_COVERAGE_PROCESS_LOG:log,
    PYTHONPATH:[coverageHook,base.PYTHONPATH].filter(Boolean).join(':')})};
}
/**
 * Turn every Python process's data into one report with repository-relative
 * paths. `-P` keeps the repository root off `sys.path`, where a `coverage/`
 * output directory would otherwise be imported in place of the package; the
 * plain environment keeps the combining process from measuring itself.
 */
async function pythonCoverage(coverageDir,{data,log},env,logs){
  const started=existsSync(log)?readFileSync(log,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  const unmeasured=Object.values(started.filter(p=>p.status!=='measured').reduce((acc,p)=>{
    const key=`${p.status} ${p.executable}`;(acc[key]??={status:p.status,executable:p.executable,count:0,example:p.argv}).count++;return acc;},{}));
  const processes={started:started.length,measured:started.length-unmeasured.reduce((n,u)=>n+u.count,0),unmeasured};
  const pieces=existsSync(data)?readdirSync(data).filter(f=>f.startsWith('.coverage.')).length:0;
  const interpreter=pythonProjects.map(python).find(p=>existsSync(p)&&spawnSync(p,['-P','-c','import coverage.cmdline'],{env}).status===0);
  let report=false;
  if(pieces&&interpreter){
    const dataFile=join(data,'.coverage'),target=join(coverageDir,'python.json');
    const combined=await run(interpreter,['-P','-m','coverage','combine',`--data-file=${dataFile}`,data],env,join(logs,'coverage-combine.log'));
    report=combined===0&&await run(interpreter,['-P','-m','coverage','json',`--data-file=${dataFile}`,'-o',target],env,join(logs,'coverage-json.log'))===0;
  }
  rmSync(data,{recursive:true,force:true});
  if(pieces&&!report)console.log(`Coverage: Python data from ${processes.measured} process(es) produced no report; see ${logs}/coverage-*.log`);
  return {report,processes};
}
/**
 * Two ways to name a set of tests, and they are deliberately different.
 *
 * `--slice` narrows the shared policy: whatever it names is a subset of
 * `pnpm test:shared`, because the predicate is appended to `shared.selector`
 * with `and`. That is what CI uses, so a job cannot reach outside the plan.
 *
 * A `--<group> <value>` query builds its own selector from the tag vocabulary
 * instead, which is how a developer asks for something the shared plan
 * excludes on purpose — a live-model journey, the legacy quarantine. Repeating
 * a group is OR within it; different groups are AND. The environment still
 * gates execution: a `model:real` case without `CI_ALLOW_REAL=1` and its
 * credentials fails preflight rather than running.
 */
function selectorFrom(query) {
  return Object.entries(query)
    .map(([group, values]) => values.length > 1 ? `(${values.map(v => `${group}:${v}`).join(' or ')})` : `${group}:${values[0]}`)
    .join(' and ');
}
/** Print each CI policy the way it would be asked for on the command line. */
function showPolicies() {
  for (const profile of Object.values(profiles)) {
    console.log(profile.definedAs === profile.name ? `${profile.name}:` : `${profile.name}: (defined as ${profile.definedAs})`);
    for (const rule of profile.rules) {
      const flags=Object.entries(rule).flatMap(([g,v])=>[v].flat().map(x=>`--${g} ${x}`)).join(' ');
      console.log(`  pnpm test:list ${flags}`);
    }
    console.log(`  selector: ${profile.selector}`);
    console.log(`  targets:  ${profile.targets.map(t=>`${t.os}/${t.arch}`).join(' ')}`);
    console.log(`  run it:   pnpm test:run --profile ${profile.name}`);
  }
  return 0;
}
/**
 * The directory, under CI_RESULTS_DIR or `.test-runs/`, that one run's plan and
 * evidence go to: the slice's own name whichever profile ran it, and `query`
 * for a tag query. CI uploads read from here; the profile is in `plan.json`.
 */
export function resultsLabel(slice, query=false) {
  return query?'query':slice;
}

export async function main(args=process.argv.slice(2)) {
  const action=args.shift()??'run';let slice,output,profileName='pr',coverage=false,backend,shard,targetArch;const query={};
  while(args.length){
    const flag=args.shift();
    // pnpm versions differ on whether the conventional separator is stripped,
    // so `pnpm ci:st -- --profile release` can arrive with it still attached.
    if(flag==='--')continue;
    if(flag==='--slice')slice=args.shift();
    else if(flag==='--profile')profileName=args.shift();
    else if(flag==='--output')output=args.shift();
    else if(flag==='--coverage')coverage=true;
    else if(flag==='--backend')backend=args.shift();
    else if(flag==='--shard')shard=args.shift();
    else if(flag==='--target-arch'){
      targetArch=args.shift();
      if(!['amd64','arm64'].includes(targetArch))throw new Error('Invalid --target-arch; use amd64 or arm64');
    }
    else if(flag?.startsWith('--')&&schema.groups[flag.slice(2)]){
      const group=flag.slice(2),value=args.shift();
      if(!schema.groups[group].values.includes(value))throw new Error(`Unknown ${group}: ${value}; expected ${schema.groups[group].values.join('|')}`);
      (query[group]??=[]).push(value);
    }
    else throw new Error(`Unknown option ${flag}; tag dimensions are --${Object.keys(schema.groups).join(', --')}`);
  }
  const dimensions=Object.keys(query);
  if(action==='policy')return showPolicies();
  const profile=profiles[profileName];
  const execution=executionConfig(process.env,backend);
  if(!profile)throw new Error(`Unknown profile: ${profileName}; known are ${Object.keys(profiles).join(', ')}`);
  if(dimensions.length&&(slice!==undefined||profileName!=='pr'))throw new Error('--profile and --slice name a part of a CI policy; a tag query builds its own selector. Use one or the other');
  slice??='shared';
  if(!['run','list','prepare'].includes(action)||!(slice in slices))throw new Error(`Usage: test:run|test:list|policy [--profile ${Object.keys(profiles).join('|')}] [--slice ut|st|e2e] [--${Object.keys(schema.groups).join(' V] [--')} V] [--output DIR] [--coverage]`);
  // Under CI the layer entry point owns `<CI_RESULTS_DIR>/<layer>/run.log` and
  // its own summary; the frozen plan and its evidence go beside them, not over them.
  const label=resultsLabel(slice,dimensions.length>0);
  const outputDir=resolve(output??(process.env.CI_RESULTS_DIR?join(process.env.CI_RESULTS_DIR,label,'tagged'):join(root,'.test-runs',label)));
  mkdirSync(outputDir,{recursive:true});
  // Caches and run data are kept inside the workspace; TMPDIR deliberately is
  // not. The Runner builds its egress socket under it, and a Unix socket path
  // is limited to 107 bytes — a checkout even moderately deep under $HOME puts
  // `<root>/.tmp/tmp/sciencediscovery-egress-XXXXXX/egress.sock` over that, and
  // the sandbox network tests fail on the path length rather than on anything
  // they assert. The system temporary directory is what these suites used
  // before they were planned, and it is what they keep.
  const env={...process.env,CI:'1',UV_CACHE_DIR:process.env.UV_CACHE_DIR||join(root,'.tmp/cache/uv'),
    UV_PYTHON_INSTALL_DIR:join(root,'.tmp/python'),npm_config_cache:join(root,'.tmp/cache/npm'),
    PLAYWRIGHT_BROWSERS_PATH:join(root,'.e2e/browsers'),CI_RESULTS_DIR:outputDir,
    // Gateway pins Python 3.12 and includes pytest for the tagged harness.
    // Benchmark checks select their own Python via SCIENCE_RESEARCH_PYTHON.
    SCIENCE_TEST_PYTHON:process.env.SCIENCE_TEST_PYTHON||python('gateway'),
    SCIENCE_DISCOVERY_DATA_DIR:join(outputDir,'runtime'),SCIENCE_AGENT_DATA_DIR:join(outputDir,'runtime')};
  // Collection scope follows the categories asked for, whichever way they were
  // asked: a query for `--category e2e` needs Chromium and not the Python
  // virtualenvs, exactly as `--slice e2e` does.
  const light=slice==='l1'||profileName==='l1';
  const workers=slice==='ut'?utWorkers(process.env.CI_UT_WORKERS):1;
  const categories=query.category??(light?['ut']:slice==='shared'?['ut','st','e2e']:[slice === 'e2e-real' ? 'e2e' : slice]);
  const needUT=!light&&categories.includes('ut'), needPW=categories.includes('e2e');
  env.CI_E2E_BACKEND=execution.backend;
  // The E2E group can split preparation from execution: a host installs
  // everything and hands the workspace over, and this half only runs.
  const prepared=process.env.CI_E2E_PREPARED==='1';
  const prepareOnly=action==='prepare' || process.env.CI_E2E_PREPARE_ONLY==='1';
  if(prepared && process.env.CI_E2E_PREPARE_ONLY==='1')throw new Error('CI_E2E_PREPARE_ONLY and CI_E2E_PREPARED are mutually exclusive');
  if(action!=='list' && !prepared) {
    const steps=[['pnpm',['install','--frozen-lockfile']],...(!light?[['pnpm',['build']]]:[])];
    if(needUT)for(const project of pythonProjects)steps.push(['uv',['sync','--project',`services/${project}`,'--locked',...(project==='evolve'?['--extra','test','--extra','candidates']:['memory-graph','idea-tree','adapter'].includes(project)?['--extra','test']:[])]])
    // Into the project's own environment, after the locked sync, so the tests
    // run on exactly the interpreter and packages they run on without it.
    if(needUT&&coverage)for(const project of pythonProjects)steps.push(['uv',['pip','install','--python',python(project),coverageRequirement]]);
    // The same compiler over the same sources, with maps beside the output, so
    // code a test reaches through `dist/` is credited to the file it came from.
    if(coverage)steps.push(['pnpm',['--recursive','--filter','./packages/*','--filter','./services/*','--filter','./config','exec','tsc','-p','tsconfig.json','--sourceMap']]);
    if(needPW)steps.push(['node',['test/sync-e2e.mjs','--write']],['npm',['ci','--prefix','.e2e']],['.e2e/node_modules/.bin/playwright',['install','chromium']]);
    for(let i=0;i<steps.length;i++){const [cmd,argv]=steps[i];console.log(`Prepare: ${cmd} ${argv.join(' ')}`);if(await run(cmd,argv,env,join(outputDir,`prepare-${i}.log`)))throw new Error(`PREPARATION_FAILED: inspect ${join(outputDir,`prepare-${i}.log`)}`);}
  }
  if(prepareOnly){console.log(`Prepared ${slice}; no test was collected or executed here.`);return 0;}
  // Source scopes follow workspace layout, never installed capabilities or environment gates.
  const nodeFiles=[...globSync([...nodeSources],{cwd:root}), ...nodeExtraSources].sort();
  const wantedCategory=categories.length===1?categories[0]:null;
  const files=light?[]:nodeFiles.filter(file=>{
    const source=readFileSync(join(root,file),'utf8');
    return !wantedCategory||source.includes(`category:${wantedCategory}`);
  });
  let catalog=[];
  if(files.length)catalog.push(...collect({root,files,outputDir,nodeImports:['tsx'],env}));
  if(needUT)for(const project of pythonProjects){
    const dir=join(outputDir,`collect-${project}`);mkdirSync(dir,{recursive:true});
    const sources=[...globSync(pythonSources(project),{cwd:root})].sort();
    catalog.push(...collect({root,files:sources,outputDir:dir,python:python(project),pytestPlugins:pythonPlugins[project]??[],env:projectEnv(env,project)}));
  }
  if(needPW){
    const destination=join(outputDir,'playwright-catalog.json');rmSync(destination,{force:true});
    const code=await run('.e2e/node_modules/.bin/playwright',['test','--config','.e2e/playwright.config.ts','--list','--reporter','./test/support/tagged/playwright-reporter.mjs'],{...env,SCIENCE_TAG_PW_CATALOG:destination},join(outputDir,'playwright-collect.log'));
    if(code||!existsSync(destination))throw new Error('PLAYWRIGHT_COLLECTION_FAILED');
    catalog.push(...JSON.parse(readFileSync(destination)).catalog);
  }
  catalog.push(...checks.filter(check=>categories.some(c=>check.tags.includes(`category:${c}`))).map(check=>({...check,source:'test/support/tagged/checks.mjs',sourceHash:fileDigest(readFileSync(join(root,'test/support/tagged/checks.mjs'))),runner:'command'})));
  // Explicit opt-in entry points are discoverable metadata, never executed by this policy.
  for(const source of ['test/api/agent_loop_real_smoke.ts','services/runner/workloads/npu-smoke-test.py']){
    const text=readFileSync(join(root,source),'utf8');catalog.push({id:`command:${source}`,source,sourceHash:fileDigest(text),runner:'command',tags:JSON.parse(text.match(/science-tags: (\[[^\n]+\])/)[1])});
  }
  const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim();
  const {os:requestedOs,arch:requestedArch,...predicates}=query;
  const selector=dimensions.length?selectorFrom(predicates):`(${profile.selector})`+(slices[slice]?` and (${slices[slice]})`:'');
  // `os` and `arch` name the execution target rather than filter the tags: the
  // plan expands a multi-platform test into one instance per target, and the
  // selector is then evaluated on that concrete instance.
  const targets=dimensions.length
    ?(requestedOs??[profile.targets[0].os]).flatMap(os=>(requestedArch??[profile.targets[0].arch]).map(arch=>({os,arch})))
    :profile.targets.map(t=>targetArch?{...t,arch:targetArch}:t);
  let plan=createPlan(catalog,{revision,selector:selector||'',targets,execution,...(dimensions.length?{}:{profile:profileName})});
  if(needPW){
    // Pin the evaluator/input implementation independently of the candidate
    // product SHA so stored scores identify their judge/rubric version.
    const sources=[...globSync(['test/benchmarks/**/*.py','test/benchmarks/**/*.json','test/benchmarks/**/*.ts','test/benchmarks/**/*.mjs','test/helpers/*result.mjs','test/helpers/real-delivery.*','test/biomnibench-da-swarm.spec.ts','.ci/biomni-gate.mjs'],{cwd:root})].sort();
    const evaluatorRevision=fileDigest(sources.map(p=>p+'\n'+fileDigest(readFileSync(join(root,p)))).join('\n'));
    plan=subplan({...plan,evaluatorRevision},plan.entries);
  }
  let selectedShard;
  if (slice === 'e2e') mockedShards(plan); // Reject unclassified cases even in a serial local run.
  if(shard){
    if(!['e2e','e2e-real'].includes(slice))throw new Error('--shard requires --slice e2e or e2e-real');
    const selected=(slice==='e2e' ? mockedShards(plan) : realShards(plan)).find(s=>s.name===shard);
    if(!selected)throw new Error(`Unknown ${slice} shard: ${shard}`);
    selectedShard=selected;
    plan=subplan(plan,plan.entries.filter(e=>selected.keys.includes(e.key)));
  }
  json(join(outputDir,'catalog.json'),catalog);json(join(outputDir,'plan.json'),plan);
  const asked=dimensions.length?`query ${dimensions.map(g=>`--${g} ${query[g].join(' --'+g+' ')}`).join(' ')}`:`profile ${profileName}, slice ${slice}`;
  console.log(`Frozen ${plan.entries.length} identities for ${asked}`);
  console.log(`selector=${selector||'(everything collected)'}; targets=${plan.targets.map(t=>`${t.os}/${t.arch}`).join(' ')}`);
  console.log(`digest=${plan.digest}; plan=${join(outputDir,'plan.json')}`);
  if(action==='list')return 0;
  const checked=await preflight(plan);
  const requireSandbox=plan.entries.some(e=>e.tags.includes('sandbox:bubblewrap'));
  if(requireSandbox && spawnSync('bwrap',['--ro-bind','/','/','--dev','/dev','true'],{env,encoding:'utf8'}).status!==0)checked.problems.push({code:'BUBBLEWRAP_UNAVAILABLE'});
  if(!light && plan.entries.some(e=>e.tags.includes('category:ut')) && process.getuid?.()===0)checked.problems.push({code:'NON_ROOT_REQUIRED'});
  checked.ok=!checked.problems.length;json(join(outputDir,'preflight.json'),checked);
  const results=[], errors=checked.problems.map(p=>JSON.stringify(p));
  const coverageDir=join(outputDir,'coverage');
  if(coverage){rmSync(coverageDir,{recursive:true,force:true});mkdirSync(coverageDir,{recursive:true});}
  // Instrumentation reaches execution only: collection above, and the command
  // checks below, run exactly as they do without `--coverage`.
  const recording=coverage?coverageSetup(outputDir,coverageDir):null;
  // What this run owes the artifact: one lcov per Node worker process it ran,
  // which is two for a file whose `swarm:required` tests run apart from the rest.
  const owed={node:0};
  if(checked.ok){
    const groups=planGroups(plan.entries);
    let peakWorkers=0;
    const timings=[],controller=new AbortController();
    const abort=()=>controller.abort();
    const aborted=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('UT scheduling aborted')),{once:true}));
    aborted.catch(()=>{});
    process.once('SIGINT',abort);process.once('SIGTERM',abort);
    console.log(`Worker pool: ${workers}; available CPUs: ${availableParallelism()}; host memory GiB: ${(totalmem()/2**30).toFixed(1)}`);
    // JiuwenSwarm starts only for a plan that holds a test declaring it, and
    // beside the other groups rather than ahead of them: only a declaring
    // group waits for it. Every other group runs without its variables.
    const declaring=groups.filter(group=>group.resource===SWARM);
    const swarmLog=join(outputDir,'swarm.log');
    const swarm=declaring.length?startSwarm({root,env,log:swarmLog}):null;
    const swarmTiming=swarm&&{tests:declaring.reduce((n,group)=>n+group.entries.length,0),groups:declaring.length,readyMs:null,exitCode:null};
    if(swarm){
      const requested=Date.now();
      swarm.ready.then(()=>{swarmTiming.readyMs=Date.now()-requested;},()=>{});
      console.log(`JiuwenSwarm: ${swarmTiming.tests} test(s) declare ${SWARM_TAG}; starting one instance for them (log: ${swarmLog})`);
    }
    const isolated=withoutSwarm(env);
    const tasks=groups.map((group,index)=>({resource:group.resource,run:async()=>{
      const {entries,source}=group;
      const project=group.runner==='python'?source.split('/')[1]:null;
      const parts=source.split('/');const cwd=['packages','services','apps'].includes(parts[0])?join(root,...parts.slice(0,2)):root;
      const label=group.resource===SWARM?`${source} [${SWARM_TAG}]`:source;
      const directory=join(outputDir,`group-${index+1}`);
      const instance=group.resource===SWARM?await Promise.race([swarm.ready,aborted]):{};
      const startedAt=new Date();
      console.log(`Run ${index+1}/${groups.length}: ${label} (${entries.length})`);
      if(coverage&&!project)owed.node++;
      const workerEnv={...isolated,...instance,SCIENCE_DISCOVERY_DATA_DIR:join(directory,'runtime'),SCIENCE_AGENT_DATA_DIR:join(directory,'runtime')};
      const base=project?projectEnv(workerEnv,project):workerEnv;
      try {
        return await execute({root,cwd,plan:subplan(plan,entries),outputDir:directory,
          python:project?python(project):undefined,pytestPlugins:project?pythonPlugins[project]??[]:[],coverageDir:!project&&coverage?join(coverageDir,'node'):undefined,coverageName:group.name,
          nodeImports:['tsx'],env:recording?recording.env(base):base,timeoutMs:600_000,signal:controller.signal});
      } finally {
        const durationMs=Date.now()-startedAt.getTime();
        timings.push({group:label,index:index+1,runner:group.runner,resource:group.resource,startedAt,durationMs});
        console.log(`Done ${index+1}/${groups.length}: ${label} (${durationMs}ms)`);
      }
    }}));
    let completed;
    try {completed=await schedule(tasks,{workers,signal:controller.signal,onChange:active=>{peakWorkers=Math.max(peakWorkers,active);}});}
    finally {
      process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);
      if(swarm)swarmTiming.exitCode=await swarm.stop();
    }
    json(join(outputDir,'timing.json'),{workers,peakWorkers,availableCpus:availableParallelism(),hostMemoryBytes:totalmem(),swarm:swarmTiming,groups:timings.sort((a,b)=>a.index-b.index)});
    for(const item of completed){
      if(item.status==='fulfilled'){results.push(...item.value.results);errors.push(...item.value.problems);}
      else errors.push(`GROUP_EXECUTION_FAILED: ${item.reason?.message??item.reason}`);
    }
    if(controller.signal.aborted)errors.push('EXECUTION_ABORTED');
    for(const entry of plan.entries.filter(e=>e.runner==='command'&&!controller.signal.aborted)){
      const [command,...argv]=entry.command;const code=await run(command,argv,isolated,join(outputDir,entry.id.replaceAll(':','-')+'.log'));
      results.push({key:entry.key,outcome:code?'FAIL':'PASS',actualTarget:entry.target});
    }
    const batches=new Map();
    for(const entry of plan.entries.filter(e=>e.runner==='playwright')) {
      const group=entry.tags.includes('model:real')?'real':'mocked';
      const fixture=entry.tags.find(tag=>tag.startsWith('fixture:'))?.split(':')[1]??'standard';
      const key=`${group}-${fixture}`;
      const batch=batches.get(key)??{group,fixture,key,entries:[]};batch.entries.push(entry);batches.set(key,batch);
    }
    // One browser run of one batch. run-e2e.sh keeps writing its stack log,
    // journey reports and Playwright output where every reader already looks
    // for them — `<results>/e2e/` — while the frozen plan and its accounting
    // stay in this slice's own directory beside them. Every attempt keeps its
    // own evidence directory, so a retry never erases the attempt it repeats.
    const browserRun=async(batch,planPath,reportPath,instance)=>{
      const code=await run('bash',['.ci/run-e2e.sh',batch.group],{...env,CI_E2E_PREPARED:'1',CI_E2E_BROWSERS_DIR:env.PLAYWRIGHT_BROWSERS_PATH,
        CI_RESULTS_DIR:join(process.env.CI_RESULTS_DIR?resolve(process.env.CI_RESULTS_DIR):outputDir,instance),
        CI_RUNTIME_DIR:resolve(root,process.env.CI_RUNTIME_DIR??join(outputDir,'e2e-runtime'),batch.key),
        CI_E2E_FIXTURE:batch.fixture,JIUWENSWARM_INSTANCE:`sd-e2e-${instance}`,
        ...(slice==='e2e'&&shard?{CI_E2E_SWARM_CHECKS:selectedShard.checks.length?'run':'off'}:{}),
        SCIENCE_TAG_PLAN:planPath,SCIENCE_TAG_PW_REPORT:reportPath,
        E2E_SCIENTIFIC_ENVS:'1'},join(outputDir,`e2e-${instance}-driver.log`),root,{echo:true});
      return {code,data:existsSync(reportPath)?JSON.parse(readFileSync(reportPath)):undefined};
    };
    for(const [key,batch] of batches){
      const report=join(outputDir,`playwright-${key}-results.json`);rmSync(report,{force:true});
      const batchPlan=join(outputDir,`playwright-${key}-plan.json`);json(batchPlan,subplan(plan,batch.entries));
      const first=await browserRun(batch,batchPlan,report,key);
      let batchResults=first.data?.results??[];
      // One repeat for a case whose first attempt died early on a transient
      // gateway fault. The case runs on its own, so a product failure is never
      // repeated, and a case that got far is never repeated either. A repeat
      // that does not work leaves the provider fault where it was — and is
      // audited, so a failed repeat is not a console line nobody reads.
      const repeat=retryableProviderFaults(batchResults);
      // A batch where every case faulted early is a gateway outage, not a
      // flaky case. Repeating the whole batch would re-run the suite against a
      // provider that is already down, so at most a couple of cases are
      // repeated as a probe; the rest keep their provider fault, and the gate
      // stays non-green either way.
      const totalOutage=batchResults.length>0&&batchResults.every(r=>r.outcome===PROVIDER_FAULT);
      const chosen=totalOutage?repeat.slice(0,OUTAGE_PROBE_REPEATS):repeat;
      if(totalOutage&&chosen.length<repeat.length)console.log(`Repeating ${chosen.length} of ${repeat.length} faulted case(s): the whole batch faulted, which reads as an outage`);
      const repeatEntries=chosen.map(r=>batch.entries.find(e=>e.key===r.key)).filter(Boolean);
      if(repeatEntries.length){
        const repeatPlan=join(outputDir,`playwright-${key}-retry-plan.json`);json(repeatPlan,subplan(plan,repeatEntries));
        const repeatReport=join(outputDir,`playwright-${key}-retry-results.json`);rmSync(repeatReport,{force:true});
        console.log(`Repeating ${repeatEntries.length} case(s) after a transient gateway fault: ${repeatEntries.map(e=>e.id).join(', ')}`);
        const again=await browserRun(batch,repeatPlan,repeatReport,`${key}-retry`);
        // A repeat that did not work is recorded, not only printed: the case
        // stays unverified and the run says why.
        if(!again.data)errors.push(providerFaultRepeatReportMissing);
        else if(again.code!==0)errors.push(providerFaultRepeatFailed(again.code));
        const repeated=new Map((again.data?.results??[]).map(r=>[r.key,r]));
        if(again.data?.errors?.length)console.log(`Gateway-fault repeat reported: ${again.data.errors.join('; ')}`);
        batchResults=batchResults.map(r=>repeated.has(r.key)?{...repeated.get(r.key),retriedAfterProviderFault:true}:r);
      }
      // The worker's exit code belongs to its first attempt, so it is paired
      // with the results that attempt reported. A worker whose only failures
      // were transient gateway faults did not fail the product: the outage is
      // already accounted for under its own code, and the report exists. It
      // is not an opaque worker failure on top of that — but it is not a pass
      // either: the accounting exits non-zero while a provider fault remains.
      // A missing report is an opaque failure and stays one.
      const firstResults=first.data?.results??[];
      const productFailures=firstResults.filter(r=>r.outcome==='FAIL');
      const providerFaultOnly=first.code===1&&!productFailures.length&&firstResults.some(r=>r.outcome===PROVIDER_FAULT);
      if(first.code&&!providerFaultOnly)errors.push(`PLAYWRIGHT_WORKER_FAILED: ${first.code}`);
      results.push(...batchResults);
      if(first.data)errors.push(...first.data.errors);else errors.push('PLAYWRIGHT_REPORT_MISSING');
    }
  }
  const summary=verifyResults(plan,results,errors);json(join(outputDir,'summary.json'),summary);
  if(coverage){
    const python=await pythonCoverage(coverageDir,recording,env,outputDir);
    // The artifact describes itself: which plan it measured, how that run went,
    // and which Python processes it started. A report built from it later does
    // not have to trust anything else.
    const lcov=existsSync(join(coverageDir,'node'))?readdirSync(join(coverageDir,'node')).filter(f=>f.endsWith('.lcov')).length:0;
    json(join(coverageDir,'manifest.json'),{schema_version:2,revision:plan.revision,profile:dimensions.length?null:profileName,slice,
      selector:plan.selector,targets:plan.targets,plan_digest:plan.digest,status:summary.status,planned:summary.planned,
      executed:summary.executed,passed:summary.passed,failed:summary.failed,skipped:summary.skipped,
      node:{lcov,expected:owed.node},python});
    console.log(`Coverage: ${lcov} Node test file(s); Python ${python.processes.started} process(es) started, ${python.processes.measured} measured, report ${python.report?'written':'none'} -> ${coverageDir}`);
  }
  console.log(JSON.stringify({status:summary.status,planned:summary.planned,executed:summary.executed,passed:summary.passed,failed:summary.failed,skipped:summary.skipped,outputDir}));
  return summary.exitCode;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().then(code=>{process.exitCode=code;}).catch(e=>{console.error(e.stack);process.exitCode=1;});
