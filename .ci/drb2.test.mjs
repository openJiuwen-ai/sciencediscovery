// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createTest } from '../test/support/tagged/compat.mjs';
import { caseIds, researchPrompt, verifyUpstream } from '../test/benchmarks/deepresearchbench-ii/upstream.mjs';
import { createPlan } from '../test/support/tagged/plan.mjs';
import { profiles } from '../test/support/tagged/profiles.mjs';
import { realShards } from '../test/support/tagged/execution.mjs';
const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });

test('132 stable DRB II identities enter L5 only, one isolated shard per task', () => {
  assert.equal(caseIds.length, 132);
  assert.equal(new Set(caseIds).size, 132);
  const catalog = caseIds.map(id => ({ id: `DRB-II-${id} full release benchmark`,
    source: 'test/deepresearchbench-ii.spec.ts', sourceHash: 'a'.repeat(64), runner: 'playwright',
    tags: ['category:e2e', 'os:linux', 'arch:amd64', 'model:real', 'judge:llm', 'tier:l5'] }));
  for (const profile of ['pr', 'merge', 'daily', 'release']) {
    const build = () => createPlan(catalog, { revision: 'test', profile, selector: profiles[profile].selector,
      targets: [{ os: 'linux', arch: 'amd64' }], execution: { backend: 'jiuwenswarm' } });
    if (profile !== 'release') { assert.throws(build, /EMPTY_SELECTION/); continue; }
    const plan = build();
    assert.equal(plan.entries.length, 132);
    if (profile === 'release') {
      const shards = realShards(plan);
      assert.equal(shards.length, 132);
      assert.equal(new Set(shards.map(s => s.name)).size, 132);
      assert.ok(shards.every(s => s.name.startsWith('drb2-') && s.keys.length === 1));
    }
  }
});

test('original prompt and excluded sources survive; answer rubrics and temporary agent caps do not leak', () => {
  const prompt = 'Original question. Never read https://example.org/blocked';
  const output = researchPrompt({ idx: 45, prompt, content: { rubric: ['SECRET ANSWER'] } });
  assert.ok(output.startsWith(prompt));
  assert.ok(output.includes('drb2-45.md'));
  assert.doesNotMatch(output, /SECRET ANSWER|at most TWO|max_subagents/);
  assert.throws(() => verifyUpstream(undefined), /required/);
});

test('score completeness and invalid verdicts fail closed without upstream or API access', () => {
  execFileSync('python3', ['-c', `
import importlib.util
s=importlib.util.spec_from_file_location('drb2', 'test/benchmarks/deepresearchbench-ii/evaluate.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
rubric={'info_recall':['a','b'],'analysis':['c'],'presentation':['d']}
scores={k:{item:{'score':1} for item in v} for k,v in rubric.items()}
assert m.summarize(scores,rubric)['overall_score']==100
assert m.summarize(scores,{**rubric,'analysis':['c','c']})['raw_items']==5
assert m.summarize(scores,{**rubric,'analysis':['c','c']})['items']==4
assert not m.validate_batch(['a','b'],{'results':[{'rubric_item':'a','score':1,'reason':'','evidence':''}]*2})
assert m.validate_batch(['a','a'],{'results':[{'rubric_item':'a','score':1,'reason':'','evidence':''}]*2})
scores['analysis']['c']['score']=-1
assert m.summarize(scores,rubric)['blocked_rate']==25
for invalid in [2, True, None, '1']:
 scores['analysis']['c']['score']=invalid
 try: m.summarize(scores,rubric)
 except ValueError: pass
 else: raise AssertionError('invalid score accepted')
del scores['analysis']['c']
try: m.summarize(scores,rubric)
except ValueError: pass
else: raise AssertionError('missing score accepted')
`]);
});

test('DRB II preparation is lightweight and does not require DRB I, HF or Jina credentials', () => {
  const script = readFileSync('.ci/prepare-real-research.sh', 'utf8');
  const branch = script.slice(script.indexOf('if [['), script.indexOf('\nfi') + 3);
  assert.doesNotMatch(branch, /JINA_API_KEY|HF_TOKEN|Ayanami/);
  assert.match(branch, /exit 0/);
  const prepare = readFileSync('test/benchmarks/deepresearchbench-ii/prepare.mjs', 'utf8');
  assert.match(prepare, /--depth=1/);
  assert.match(prepare, /--filter=blob:none/);
  assert.match(prepare, /--locked/);
});

test('Judge transport and runner complete/error/truncation paths are hermetic', () => {
  execFileSync('python3', ['test/benchmarks/deepresearchbench-ii/test_evaluate.py'], { stdio: 'pipe' });
});
