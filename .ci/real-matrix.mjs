import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { validatePlan } from '../test/support/tagged/plan.mjs';
import { biomniCase, realShards } from '../test/support/tagged/execution.mjs';
import { dataset } from './biomni-gate.mjs';

// Issue #346 temporary Manual offline local-variant repeat-grade lane (branch-local flag).
if (existsSync('.ci/issue-346-local-repeat-grade.flag')) {
  const matrix = {
    include: [
      {
        shard: 'issue-346-local-repeat-grade',
        timeout: 120,
        biomni_case: 'da-13-3',
      },
    ],
  };
  appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
  console.log('issue-346-local-repeat-grade: 1 isolated offline local-variant judge worker (no research rerun)');
  process.exit(0);
}

const plan = validatePlan(JSON.parse(readFileSync(process.argv[2], 'utf8')));
if (['release', 'l5'].includes(plan.profile)) {
  const selected = plan.entries.map(biomniCase).filter(Boolean).sort();
  if (JSON.stringify(selected) !== JSON.stringify(dataset.tasks.map(t => t.id).sort())) throw new Error('BIOMNI_PUBLIC_50_PLAN_REQUIRED');
}
const matrix = { include: realShards(plan).map(({name, keys}) => {
  const biomni = plan.entries.filter(e => keys.includes(e.key)).map(biomniCase).filter(Boolean);
  if (biomni.length > 1) throw new Error('Biomni requires one task per isolated worker');
  return { shard: name, timeout: biomni.length ? 360 : name === 'basic' ? 60 : 240, biomni_case: biomni[0] ?? '' };
}) };
if (!matrix.include.length || matrix.include.length > 256) throw new Error('Invalid real E2E matrix size');
appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
console.log(`${plan.profile}: ${plan.entries.length} identities, ${matrix.include.length} isolated workers; backend=${plan.execution.backend}`);
