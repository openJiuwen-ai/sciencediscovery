// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, readFileSync } from 'node:fs';
import { validatePlan } from '../test/support/tagged/plan.mjs';
import { biomniCase, realShards } from '../test/support/tagged/execution.mjs';
import { dataset } from './biomni-gate.mjs';
const plan = validatePlan(JSON.parse(readFileSync(process.argv[2], 'utf8')));
if (['release', 'l5'].includes(plan.profile) && !plan.biomni_case_ids) {
  const selected = plan.entries.map(biomniCase).filter(Boolean).sort();
  if (JSON.stringify(selected) !== JSON.stringify(dataset.tasks.map(t => t.id).sort())) throw new Error('BIOMNI_PUBLIC_50_PLAN_REQUIRED');
}
if (plan.biomni_case_ids) {
  if (!Array.isArray(plan.biomni_case_ids) || !plan.biomni_case_ids.length
      || new Set(plan.biomni_case_ids).size !== plan.biomni_case_ids.length
      || plan.biomni_case_ids.some(id => !dataset.tasks.some(task => task.id === id))) {
    throw new Error('INVALID_BIOMNI_CASE_SELECTION');
  }
  const selected = plan.entries.map(biomniCase).filter(Boolean).sort();
  if (JSON.stringify(selected) !== JSON.stringify([...plan.biomni_case_ids].sort())) throw new Error('BIOMNI_CASE_SELECTION_MISMATCH');
}
const matrix = { include: realShards(plan).map(({name, keys}) => {
  const biomni = plan.entries.filter(e => keys.includes(e.key)).map(biomniCase).filter(Boolean);
  if (biomni.length > 1) throw new Error('Biomni requires one task per isolated worker');
  return { shard: name, timeout: biomni.length ? 360 : name === 'basic' ? 60 : 240, biomni_case: biomni[0] ?? '' };
}) };
if (!matrix.include.length || matrix.include.length > 256) throw new Error('Invalid real E2E matrix size');
appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
console.log(`${plan.profile}: ${plan.entries.length} identities, ${matrix.include.length} isolated workers; backend=${plan.execution.backend}`);
