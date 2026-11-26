// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validatePlan } from '../test/support/tagged/plan.mjs';
import { mockedShards, PARALLEL_MOCKED_SHARDS } from '../test/support/tagged/execution.mjs';
import { SELF_HOSTED_RUNNER } from './tier-policy.mjs';

export const HEAVY_MOCKED_SHARDS = Object.freeze(new Set([
  'standard-config',
  'standard-journeys',
  'research',
]));

export function buildMockedMatrix(plan, { selfHostedMergeQueue = false } = {}) {
  const include = mockedShards(plan).map(({ name }) => {
    const selfHosted = selfHostedMergeQueue === true && HEAVY_MOCKED_SHARDS.has(name);
    return {
      shard: name,
      runner: selfHosted ? [...SELF_HOSTED_RUNNER] : 'ubuntu-latest',
      self_hosted: selfHosted,
      local_concurrency: PARALLEL_MOCKED_SHARDS.has(name) ? 2 : 1,
    };
  });
  // One worker per isolated mocked stack. The ceiling guards against a plan that
  // silently fans out into an unbounded number of stacks; `governed` joined it for
  // the offline governed-download journeys, which need their own API entrypoint.
  if (!include.length || include.length > 5) throw new Error('Invalid mocked E2E matrix size');
  return { include };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = validatePlan(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  const matrix = buildMockedMatrix(plan, {
    selfHostedMergeQueue: process.env.CI_SELF_HOSTED_MERGE_QUEUE === 'true',
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
  const selfHostedCount = matrix.include.filter(entry => entry.self_hosted).length;
  console.log(
    `${plan.entries.length} mocked identities, ${matrix.include.length} isolated workers ` +
    `(${selfHostedCount} self-hosted); backend=${plan.execution.backend}`,
  );
}
