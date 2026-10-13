// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, readFileSync } from 'node:fs';
import { validatePlan } from '../test/support/tagged/plan.mjs';
import { realShards } from '../test/support/tagged/execution.mjs';
const plan = validatePlan(JSON.parse(readFileSync(process.argv[2], 'utf8')));
const matrix = { include: realShards(plan).map(({name}) => ({ shard: name, timeout: name === 'basic' ? 60 : 240 })) };
if (!matrix.include.length || matrix.include.length > 256) throw new Error('Invalid real E2E matrix size');
appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
console.log(`${plan.profile}: ${plan.entries.length} identities, ${matrix.include.length} isolated workers; backend=${plan.execution.backend}`);
