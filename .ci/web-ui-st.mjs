// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

const journeys = {
  'test/journey-mcp-oauth.spec.ts': /mcp/i,
  'test/journey-idea-tree-fixture.spec.ts': /idea.?tree/i,
  'test/journey-evolve-initialization.spec.ts': /evolve/i,
  'test/journey-restore-research.spec.ts': /research|continuation|branch|memory|provenance/i,
};

export function webUiStSelection(paths) {
  if (!paths?.length) return 'all';
  const selected = new Set();
  for (const path of paths) {
    if (Object.hasOwn(journeys, path)) {
      selected.add(path);
    } else if (path.startsWith('apps/web/src/')) {
      const matching = Object.entries(journeys).filter(([, pattern]) => pattern.test(path));
      if (!matching.length) return 'all';
      for (const [spec] of matching) selected.add(spec);
    } else if (/^(?:apps\/web\/|services\/|packages\/|config\/|scripts\/|test\/(?:source-test-map\.json$|fixtures\/|helpers\/|support\/|e2e[.-]|playwright\.|sync-e2e)|\.ci\/|\.github\/workflows\/|package\.json|pnpm-)/u.test(path)) {
      return 'all';
    }
  }
  return selected.size ? JSON.stringify([...selected].sort()) : 'none';
}

export function webUiStEntries(entries, selection) {
  const specs = selection === 'all' ? Object.keys(journeys) : JSON.parse(selection);
  if (!Array.isArray(specs) || !specs.length || specs.some(spec => !Object.hasOwn(journeys, spec))) {
    throw new Error('INVALID_WEB_UI_ST_SELECTION');
  }
  const selected = entries.filter(entry => specs.includes(entry.source));
  for (const spec of specs) {
    if (!selected.some(entry => entry.source === spec)) throw new Error(`WEB_UI_ST_EVIDENCE_MISSING: ${spec}`);
  }
  return selected;
}
