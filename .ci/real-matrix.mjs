// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, readFileSync } from 'node:fs';
import { validatePlan } from '../test/support/tagged/plan.mjs';
import { realShards } from '../test/support/tagged/execution.mjs';
const plan = validatePlan(JSON.parse(readFileSync(process.argv[2], 'utf8')));
const byKey = new Map(plan.entries.map(entry => [entry.key, entry]));
// Each attempt repeats every shard on a fresh runner, so a long case is never
// repeated inside one worker's time limit and each attempt keeps its own scores.
const attempts = Number(process.env.CI_REAL_ATTEMPTS ?? '1');
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error('CI_REAL_ATTEMPTS must be an integer from 1 to 5');
const attemptList = Array.from({ length: attempts }, (_, index) => index + 1);
const shards = realShards(plan).map(({name, keys}) => ({
  shard: name,
  timeout: name === 'basic' ? 60 : 240,
  prepareBiomni: keys.some(key => byKey.get(key)?.source === 'test/biomnibench-da-swarm.spec.ts'),
}));
const matrix = { include: attemptList.flatMap(attempt => shards.map(shard => ({ ...shard, attempt }))) };
if (!matrix.include.length || matrix.include.length > 256) throw new Error('Invalid real E2E matrix size');
appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\nattempts=${JSON.stringify(attemptList)}\n`);
console.log(`${plan.profile}: ${plan.entries.length} identities, ${shards.length} isolated workers x ${attempts} attempt(s); backend=${plan.execution.backend}`);
