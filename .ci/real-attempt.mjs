// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
// Helpers for repeated real E2E attempts: pick one try per shard for an
// attempt's accounting, and print that attempt's projected scores.
import { appendFileSync, cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

const [command, ...args] = process.argv.slice(2);

if (command === 'collect') {
  // Score artifacts are named real-e2e-results-a<attempt>-<shard>-r<run attempt>.
  // A re-run of a failed try uploads beside the earlier one; the latest counts.
  const [attempt, downloads, results] = args;
  const pattern = new RegExp(`^real-e2e-results-a${attempt}-(.+)-r(\\d+)$`);
  const latest = new Map();
  for (const name of existsSync(downloads) ? readdirSync(downloads) : []) {
    const match = pattern.exec(name);
    if (!match) continue;
    const [, shard, run] = match;
    if (!latest.has(shard) || Number(run) > latest.get(shard).run) latest.set(shard, { run: Number(run), name });
  }
  rmSync(results, { recursive: true, force: true });
  for (const [shard, { run, name }] of [...latest].sort()) {
    cpSync(join(downloads, name), join(results, `real-e2e-results-${shard}`), { recursive: true });
    console.log(`attempt ${attempt}: ${shard} from run attempt ${run}`);
  }
} else if (command === 'scores') {
  // The staged files are already projected to score fields only.
  const [root] = args;
  const rows = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('-metrics.json')) {
        const doc = JSON.parse(readFileSync(path, 'utf8'));
        const fields = { case: doc.case ?? doc.case_id, integration: doc.integration_status ?? doc.integration,
          evaluation: doc.evaluation, llm_evaluation: doc.llm_evaluation, generation_duration_ms: doc.generation_duration_ms };
        rows.push(`| \`${relative(root, path)}\` | \`${JSON.stringify(fields)}\` |`);
      }
    }
  };
  if (existsSync(root)) visit(root);
  const report = `\n### Attempt scores\n\n| File | Score fields |\n| --- | --- |\n${rows.sort().join('\n') || '| (none) | |'}\n`;
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
} else {
  console.error('Usage: node .ci/real-attempt.mjs collect <attempt> <downloads> <results> | scores <staged-scores>');
  process.exitCode = 2;
}
