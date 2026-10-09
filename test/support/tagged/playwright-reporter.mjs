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

import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileDigest, validatePlan, canonical } from './plan.mjs';
import { normalizeTags } from './tags.mjs';
import { hostPlatform, hostArch } from './environment.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
function descriptor(test) {
  const source = relative(root, test.location.file).replaceAll('\\','/');
  return { id: `playwright:${source}::${test.titlePath().filter(Boolean).map(encodeURIComponent).join('/')}`,
    source, sourceHash: fileDigest(readFileSync(resolve(root, source))), runner: 'playwright',
    tags: normalizeTags(test.tags.filter(t=>t.startsWith('@') && t.includes(':')).map(t=>t.slice(1))) };
}
export default class TaggedReporter {
  results = []; errors = []; entries = new Map();
  onBegin(config, suite) {
    const tests=suite.allTests();
    const catalog=tests.map(descriptor);
    if (process.env.SCIENCE_TAG_PW_CATALOG) {
      writeFileSync(process.env.SCIENCE_TAG_PW_CATALOG, JSON.stringify({catalog},null,2));
      return;
    }
    const plan=validatePlan(JSON.parse(readFileSync(process.env.SCIENCE_TAG_PLAN,'utf8')));
    this.entries=new Map(plan.entries.filter(e=>e.runner==='playwright').map(e=>[e.id,e]));
    for (const d of catalog) {
      const e=this.entries.get(d.id);
      if(!e || e.sourceHash!==d.sourceHash || canonical(e.tags)!==canonical(d.tags)) throw new Error(`COLLECTION_DRIFT: ${d.id}`);
    }
    if(catalog.length!==this.entries.size) throw new Error('PLAYWRIGHT_PLAN_MISMATCH');
  }
  onTestEnd(test,result) {
    const d=descriptor(test), e=this.entries.get(d.id);
    if(!e) { this.errors.push(`UNEXPECTED_RESULT: ${d.id}`);return; }
    this.results.push({key:e.key, outcome:result.status==='passed'?'PASS':result.status==='skipped'?'SKIPPED':'FAIL',
      actualTarget:{os:hostPlatform(process.platform),arch:hostArch(process.arch)},
      errors:result.errors.map(error=>error.message)});
  }
  onError(error) { this.errors.push(error.message); }
  onEnd() {
    if(process.env.SCIENCE_TAG_PW_CATALOG) return;
    writeFileSync(process.env.SCIENCE_TAG_PW_REPORT,JSON.stringify({results:this.results,errors:this.errors},null,2));
    if(this.errors.length || this.results.length!==this.entries.size || this.results.some(r=>r.outcome!=='PASS')) return {status:'failed'};
  }
}
