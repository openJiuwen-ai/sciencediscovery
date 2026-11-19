import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const validPath = (value) => typeof value === "string"
  && !/[:\\]/u.test(value)
  && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
const fileExists = (root, path) => statSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true;
const hasText = (value) => typeof value === "string" && value.trim().length > 0;

const mapPath = (root) => join(root, "test", "source-test-map.json");

export async function loadSourceTestMap(repositoryRoot) {
  const parsed = JSON.parse(await readFile(mapPath(repositoryRoot), "utf8"));
  if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("source-test-map.json must declare version 1 and entries[]");
  return parsed;
}

/**
 * Validate the small, reviewable inventory used by changed-path CI. The map is
 * deliberately explicit: a source file is not considered covered merely
 * because some broad suite happens to import it.
 */
export async function sourceTestMapProblems(repositoryRoot = fileURLToPath(new URL("..", import.meta.url)), today = new Date().toISOString().slice(0, 10)) {
  const problems = [];
  let map;
  try { map = await loadSourceTestMap(repositoryRoot); } catch (error) { return [`SOURCE_TEST_MAP_INVALID: ${error.message}`]; }
  const sources = new Set();
  for (const [index, entry] of map.entries.entries()) {
    const label = `source-test-map[${index}]`;
    if (!validPath(entry?.source) || sources.has(entry.source)) {
      problems.push(`${label}: source is missing, non-canonical or duplicated`); continue;
    }
    sources.add(entry.source);
    if (!/^(P0|P1|P2)$/.test(entry.risk ?? "")) problems.push(`${label}: risk must be P0, P1 or P2`);
    if (!hasText(entry.owner)) problems.push(`${label}: owner is required`);
    if (!fileExists(repositoryRoot, entry.source)) problems.push(`${label}: source does not exist: ${entry.source}`);
    let hasWaiver = false;
    if (entry.waiver != null) {
      const { owner, expiry } = entry.waiver;
      const expiryTime = /^\d{4}-\d{2}-\d{2}$/u.test(expiry ?? "") ? Date.parse(`${expiry}T00:00:00Z`) : NaN;
      if (!hasText(owner) || !Number.isFinite(expiryTime) || new Date(expiryTime).toISOString().slice(0, 10) !== expiry) {
        problems.push(`${label}: waiver requires an owner and a valid expiry date (YYYY-MM-DD)`);
      } else if (expiry < today) {
        problems.push(`${label}: waiver expired on ${expiry}`);
      } else {
        hasWaiver = true;
      }
    }
    if (!Array.isArray(entry.tests)) {
      problems.push(`${label}: tests must be an array`); continue;
    }
    if (entry.tests.length === 0 && !hasWaiver) problems.push(`${label}: test evidence or a valid waiver is required`);
    const evidenceKeys = new Set();
    for (const [testIndex, evidence] of entry.tests.entries()) {
      const evidenceLabel = `${label}.tests[${testIndex}]`;
      if (!validPath(evidence?.source) || !TEST_FILE.test(evidence.source) || !fileExists(repositoryRoot, evidence.source)) {
        problems.push(`${evidenceLabel}: test source must name an existing repository test file`);
      }
      if (evidence?.identity !== undefined && !hasText(evidence.identity)) {
        problems.push(`${evidenceLabel}: identity must be a non-empty collected case ID`);
      }
      const key = JSON.stringify([evidence?.source, evidence?.layer, evidence?.identity]);
      if (evidenceKeys.has(key)) problems.push(`${evidenceLabel}: duplicate test evidence`);
      evidenceKeys.add(key);
      if (!['ut', 'st', 'ui-st', 'e2e'].includes(evidence?.layer)) problems.push(`${evidenceLabel}: invalid layer`);
      if (!/^C[1-4]$/.test(evidence?.complexity ?? "")) problems.push(`${evidenceLabel}: complexity must be C1-C4`);
    }
  }
  return problems;
}


// A legacy file-level entry is still useful for changed-path routing. An
// explicit identity, however, has to resolve in the actual runner catalog.
export async function sourceTestIdentityProblems(repositoryRoot, catalog, categories) {
  const byId = new Map(catalog.map(test => [test.id, test]));
  const problems = [];
  const map = await loadSourceTestMap(repositoryRoot);
  for (const entry of map.entries) {
    for (const evidence of entry.tests) {
      if (evidence.identity === undefined) continue;
      const category = evidence.layer === 'ui-st' ? 'e2e' : evidence.layer;
      if (!categories.includes(category)) continue;
      const collected = byId.get(evidence.identity);
      const prefix = `${entry.source}: ${evidence.identity}`;
      if (!collected) problems.push(`${prefix}: identity not collected`);
      else if (collected.source !== evidence.source) problems.push(`${prefix}: collected from ${collected.source}, expected ${evidence.source}`);
      else if (!collected.tags.includes(`category:${category}`) || (category === 'e2e' && collected.runner !== 'playwright')) {
        problems.push(`${prefix}: collected case does not match layer ${evidence.layer}`);
      }
      else if (collected.forbiddenSkip) problems.push(`${prefix}: collected case is disabled`);
    }
  }
  return problems;
}
