// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, readFileSync } from 'node:fs';
import { validatePlan } from '../test/support/tagged/plan.mjs';
import { mockedShards } from '../test/support/tagged/execution.mjs';
const plan = validatePlan(JSON.parse(readFileSync(process.argv[2], 'utf8')));
// Four slots serve five partitions: create large partitions first so a long
// journey worker does not wait behind the short fixture-only workers.
const shards = mockedShards(plan).sort((a, b) => b.keys.length - a.keys.length || a.name.localeCompare(b.name));
const matrix = { include: shards.map(({ name }) => ({ shard: name })) };
// One job per fixture/state partition. The ceiling guards against a plan that
// silently fans out into an unbounded number of jobs; `governed` joined it for
// the offline governed-download journeys, which need their own API entrypoint.
if (!matrix.include.length || matrix.include.length > 5) throw new Error('Invalid mocked E2E matrix size');
appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
console.log(`${plan.entries.length} mocked identities, ${matrix.include.length} isolated workers; backend=${plan.execution.backend}`);
