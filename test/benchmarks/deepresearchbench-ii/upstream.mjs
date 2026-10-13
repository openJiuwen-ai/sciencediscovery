// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const revision = 'b38f360603db9531b102aef8c166cedb8509b6f6';
export const repository = 'https://github.com/imlrz/DeepResearch-Bench-II.git';
// Static identities: collection never downloads data or inspects credentials.
export const caseIds = Object.freeze(Array.from({ length: 132 }, (_, i) => i + 1));
export const hashes = Object.freeze({
  'tasks_and_rubrics.jsonl': '263aaabb8c279fb16cbe7c9499afe82d657a8ab3ccfb07ace084387e367d921a',
  'run_evaluation.py': '04ec1698c970f1a3c8a565a4e7b63e9c11845e6680472c4dcf30c5139eb8d775',
  'gpt_client.py': '1c2d590448ff2ca3997266a874faa0c9b02c5905a68b58b636dbafea4a175904',
});
export function verifyUpstream(directory) {
  if (!directory) throw new Error('DRB2_UPSTREAM_DIR is required; run prepare.mjs');
  if (execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision)
    throw new Error('DRB II upstream revision mismatch');
  execFileSync('git', ['-C', directory, 'diff', '--exit-code', 'HEAD', '--',
    'pyproject.toml', 'uv.lock', 'LICENSE', 'DATA_LICENSE'], { stdio: 'pipe' });
  for (const [file, expected] of Object.entries(hashes)) {
    if (createHash('sha256').update(readFileSync(join(directory, file))).digest('hex') !== expected)
      throw new Error(`DRB II checksum mismatch: ${file}`);
  }
  const rows = readFileSync(join(directory, 'tasks_and_rubrics.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  if (JSON.stringify(rows.map(r => r.idx).sort((a, b) => a - b)) !== JSON.stringify(caseIds))
    throw new Error('DRB II must contain exactly IDs 1–132');
  return rows;
}

export function researchPrompt(task) {
  if (typeof task.prompt !== 'string' || !task.prompt.trim()) throw new Error('Missing original prompt');
  return `${task.prompt}\n\nDeliver the complete report as a declared Markdown Artifact named drb2-${task.idx}.md and identify it in your final answer. Preserve all original task constraints, including the excluded sources.`;
}
