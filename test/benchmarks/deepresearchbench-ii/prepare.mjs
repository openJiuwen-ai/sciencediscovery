// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { repository, revision, verifyUpstream } from './upstream.mjs';

const directory = resolve(process.argv[2] ?? '.benchmark-cache/drb2');
const git = (...args) => execFileSync('git', ['-C', directory, ...args], { stdio: 'inherit' });
if (!existsSync(directory)) {
  mkdirSync(directory, { recursive: true });
  git('init');
  git('remote', 'add', 'origin', repository);
  git('sparse-checkout', 'init', '--no-cone');
  git('sparse-checkout', 'set', '/tasks_and_rubrics.jsonl', '/run_evaluation.py', '/gpt_client.py',
    '/aggregate_scores.py', '/pyproject.toml', '/uv.lock', '/LICENSE', '/DATA_LICENSE');
  git('fetch', '--depth=1', '--filter=blob:none', 'origin', revision);
  git('checkout', '--detach', 'FETCH_HEAD');
}
verifyUpstream(directory); // Existing caches are never silently reset or trusted.
// Import the pinned scripts directly; upstream is not a distributable flat-layout package.
execFileSync('uv', ['sync', '--project', directory, '--locked', '--no-install-project'], { stdio: 'inherit' });
console.log(`Verified DRB II ${revision}; 132 tasks; ${directory}`);
