// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTest } from '../test/support/tagged/compat.mjs';
import { profiles, slices } from '../test/support/tagged/profiles.mjs';
import { compileSelector, normalizeTags } from '../test/support/tagged/tags.mjs';
import { createPlan } from '../test/support/tagged/plan.mjs';
import { preflight } from '../test/support/tagged/environment.mjs';
import { planGrep } from '../test/support/tagged/playwright-selection.mjs';
const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });

test('Swarm UT defaults to platform task delegation and preserves an explicit native override', () => {
  const source = readFileSync(new URL('../scripts/with-jiuwenswarm.sh', import.meta.url), 'utf8');
  assert.ok(source.includes('export SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS="${SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS:-task}"'));
});

test('Docker and binaries build patched Swarm; service start only verifies it', () => {
  for (const path of ['Dockerfile', 'scripts/binary-release/build-payload.sh']) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.match(source, /build-swarm-wheel\.sh/);
    assert.match(source, /swarm-patches\.py"? verify/);
  }
  const service = readFileSync(new URL('../scripts/jiuwenswarm.sh', import.meta.url), 'utf8');
  const start = service.split('cmd_start() {')[1].split('\ncmd_')[0];
  assert.match(start, /verify_compatibility_patches/);
  assert.doesNotMatch(start, /apply_compatibility_patches/);
});

test('PR gates hermetic UT/ST/mock and daily adds every real E2E; release spends no model tokens', () => {
  for (const category of ['ut','st','e2e']) for (const model of ['none','mock','real']) {
    const tags=normalizeTags([`category:${category}`,`model:${model}`,'os:linux','arch:amd64']);
    assert.equal(compileSelector(profiles.pr.selector)(tags), model !== 'real');
    assert.equal(compileSelector(profiles.daily.selector)(tags), model !== 'real' || category === 'e2e');
    assert.equal(compileSelector(profiles.release.selector)(tags), model !== 'real');
    const expected = model === 'real' ? 'e2e-real' : category;
    const matches = Object.entries(slices).filter(([name,selector])=>name!=='shared'&&compileSelector(selector)(tags));
    if(model !== 'real' || category === 'e2e') assert.deepEqual(matches.map(([name])=>name),[expected]);
  }
});

test('OR-ed daily policy cannot leak UT identities into its real E2E slice', () => {
  const selector=compileSelector(`(${profiles.daily.selector}) and (${slices['e2e-real']})`);
  assert.equal(selector(normalizeTags(['category:ut','os:linux','arch:amd64'])),false);
});

test('real prerequisites fail closed, independent of catalog selection', async () => {
  const plan=createPlan([{id:'live',source:'test/live.spec.ts',sourceHash:'a'.repeat(64),runner:'playwright',
    tags:['category:e2e','model:real','judge:llm','os:linux','arch:amd64']}],
    {revision:'test',selector:profiles.daily.selector,targets:[{os:'linux',arch:'amd64'}]});
  const checked=await preflight(plan,{platform:'linux',arch:'x64',env:{}});
  assert.equal(checked.ok,false);
  assert.ok(checked.problems.some(p=>p.requirement==='E2E_LLM_TOKEN'));
  assert.ok(checked.problems.some(p=>p.requirement==='E2E_JUDGE_TOKEN'));
});

test('frozen Playwright title matches inherited tags but not unplanned sibling tests', () => {
  const regex=planGrep([{runner:'playwright',id:'playwright:test/a.spec.ts::real/a.spec.ts/group/a%20task%20(1)'}]);
  assert.ok(regex.test('real a.spec.ts group @model:real @os:linux a task (1) @real'));
  assert.ok(!regex.test('real a.spec.ts group @model:real a different task @real'));
  assert.throws(()=>planGrep([]));
});

test('scheduled real credentials are isolated from pull request jobs', () => {
  const text=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  const live=text.slice(text.indexOf('  real-e2e:'),text.indexOf('\n  ut:'));
  assert.match(live,/inputs.profile == 'daily' && github.event_name != 'pull_request'/);
  assert.match(live,/environment: nightly-research/);
  // runner is not available in jobs.<job_id>.env (it is available in step env).
  const jobEnv = live.slice(live.indexOf('\n    env:'), live.indexOf('\n    steps:'));
  assert.doesNotMatch(jobEnv, /\$\{\{[^}]*\brunner\./);
  assert.match(jobEnv, /CI_RUNTIME_DIR: \$\{\{ github\.workspace \}\}\/\.ci-runtime\/real-e2e/);
  assert.match(live,/run: pnpm ci:e2e:real/);
  assert.doesNotMatch(text.slice(text.indexOf('\n  ut:')),/secrets\.E2E_LLM_TOKEN/);
});
