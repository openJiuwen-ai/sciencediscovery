import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadSourceTestMap } from "./source-test-map.mjs";

const root = process.cwd();
const output = process.env.OVERLAP_REPORT ?? resolve(root, ".ci-results", "overlap-report.json");
const map = await loadSourceTestMap(root);
const byTest = new Map();
for (const entry of map.entries) for (const evidence of entry.tests ?? []) {
  const row = byTest.get(evidence.source) ?? { evidence: evidence.source, sourceEntries: [], layers: new Set(), tests: [], owners: new Set() };
  row.sourceEntries.push(entry.source);
  row.layers.add(evidence.layer);
  row.tests.push({ source: entry.source, layer: evidence.layer, complexity: evidence.complexity });
  row.owners.add(entry.owner);
  byTest.set(evidence.source, row);
}
const namesFor = async (source) => {
  try {
    const contents = await readFile(join(root, source), "utf8");
    const names = [];
    const patterns = [/(?:test|it|describe)\s*\(\s*["'`]([^"'`]+)["'`]/gu, /test\.describe\s*\(\s*["'`]([^"'`]+)["'`]/gu];
    for (const pattern of patterns) for (const match of contents.matchAll(pattern)) names.push(match[1]);
    return [...new Set(names)].slice(0, 50);
  } catch { return []; }
};
const sharedEvidence = [];
const testsByName = new Map();
for (const row of byTest.values()) {
  const sourceEntries = [...new Set(row.sourceEntries)].sort();
  const testNames = await namesFor(row.evidence);
  if (sourceEntries.length >= 2) {
    sharedEvidence.push({
      evidence: row.evidence,
      sourceEntries,
      layers: [...row.layers].sort(),
      owners: [...row.owners].sort(),
      testNames,
      tests: row.tests,
      action: "review-before-delete",
      decision: "shared evidence, distinct assertions must be proven before consolidation",
      reviewStatus: "pending",
    });
  }
  for (const name of testNames) {
    const normalized = name.trim();
    if (normalized.length < 12 || !/[A-Za-z\u4e00-\u9fff]/u.test(normalized)) continue;
    const files = testsByName.get(normalized) ?? new Set();
    files.add(row.evidence);
    testsByName.set(normalized, files);
  }
}
const duplicateTests = [...testsByName.entries()]
  .filter(([, files]) => files.size > 1)
  .map(([name, files]) => ({
    name,
    evidence: [...files].sort(),
    action: "review-before-delete",
    decision: "identical test titles require assertion-level review before consolidation",
    reviewStatus: "pending",
  }))
  .sort((left, right) => left.name.localeCompare(right.name));
const report = {
  generatedAt: new Date().toISOString(),
  sourceEntries: map.entries.length,
  evidenceFiles: byTest.size,
  sharedEvidence,
  duplicateEvidence: sharedEvidence,
  duplicateTests,
  governance: {
    requiredFields: ["target", "fixture", "assertions", "owner", "decision", "reviewStatus"],
    deletionRule: "delete an identity only after two release cycles show equivalent target, fixture, assertions and layer",
  },
  policy: "Shared evidence and identical test titles are reported separately. The report uses a never deleted automatically policy because recovery, permission, version and provenance cases may legitimately share a test file or title.",
};
await mkdir(join(root, ".ci-results"), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Overlap report written to ${output}: ${sharedEvidence.length} shared evidence file(s), ${duplicateTests.length} duplicate test title(s)`);
