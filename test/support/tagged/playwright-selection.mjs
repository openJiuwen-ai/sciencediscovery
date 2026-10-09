// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Playwright inserts inherited suite tags between describe titles in grep text. */
export function planGrep(entries) {
  const titles = entries.filter(e => e.runner === 'playwright').map(e =>
    e.id.split('::')[1].split('/').map(decodeURIComponent).map(escape).join('(?: @\\S+)* '));
  if (!titles.length) throw new Error('No browser identities in worker plan');
  return new RegExp(`^(?:${titles.join('|')})(?: |$)`);
}
