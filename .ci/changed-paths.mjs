// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';

const documentationFiles = new Set([
  'README.md', 'README_zh.md', 'CONTRIBUTING.md', 'LICENSE',
  'Third_Party_Open_Source_Software_Notice.txt',
]);
const diffEvents = new Set(['pull_request', 'push', 'merge_group']);

export function documentationOnly(paths) {
  return Array.isArray(paths) && paths.length > 0 && paths.every(path =>
    typeof path === 'string' && (documentationFiles.has(path) || path.startsWith('docs/')));
}

// Unknown/missing history must preserve the full profile. Disabling rename
// detection lists both the deleted old path and the added new path.
export function changedPaths(eventName, event, { enabled = true, git = args =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }) } = {}) {
  if (!enabled || !diffEvents.has(eventName)) return null;
  const [base, head] = eventName === 'pull_request'
    ? [event?.pull_request?.base?.sha, event?.pull_request?.head?.sha]
    : eventName === 'merge_group'
      ? [event?.merge_group?.base_sha, event?.merge_group?.head_sha]
      : [event?.before, event?.after];
  if (![base, head].every(sha => typeof sha === 'string' && /^[a-f\d]{40}$/i.test(sha) && !/^0+$/.test(sha))) return null;
  try {
    const range = eventName === 'pull_request' ? [`${base}...${head}`] : [base, head];
    const output = git(['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', ...range, '--']);
    if (!output || !output.endsWith('\0')) return null;
    const paths = output.slice(0, -1).split('\0');
    return paths.every(Boolean) ? paths : null;
  } catch {
    return null;
  }
}
