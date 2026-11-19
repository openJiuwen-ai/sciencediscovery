// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCombinationJourneys } from "./combination-journeys.mjs";
import { canonical, validatePlan } from "../test/support/tagged/plan.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

export function reconcileCombinationBrowserEvidence(journeys, plan, results) {
  const byKey = new Map();
  for (const result of results) {
    const matches = byKey.get(result.key) ?? [];
    matches.push(result);
    byKey.set(result.key, matches);
  }
  const evidence = journeys.map(({ id, productBrowserSpecs }) => {
    const specs = productBrowserSpecs.map((source) => {
      const cases = plan.entries.filter((entry) => entry.runner === "playwright" && entry.source === source).map(({ key, target, backend }) => {
        const matches = byKey.get(key) ?? [];
        if (matches.length > 1) return { key, outcome: "DUPLICATE" };
        const [result] = matches;
        if (!result) return { key, outcome: "NOT_RUN" };
        if (canonical(result.actualTarget) !== canonical(target) || result.actualBackend !== backend) {
          return { key, outcome: "MISMATCH" };
        }
        return { key, outcome: result.outcome };
      });
      return { source, cases, passed: cases.length > 0 && cases.every(({ outcome }) => outcome === "PASS") };
    });
    return { id, specs, passed: specs.every(({ passed }) => passed) };
  });
  return {
    planDigest: plan.digest,
    revision: plan.revision,
    status: evidence.every(({ passed }) => passed) ? "PASS" : "FAIL",
    evidence,
  };
}

export async function combinationBrowserEntries(entries) {
  const journeys = await loadCombinationJourneys(root);
  const sources = new Set(journeys.flatMap(({ productBrowserSpecs }) => productBrowserSpecs));
  const selected = entries.filter((entry) => entry.runner === "playwright" && sources.has(entry.source));
  for (const source of sources) {
    if (!selected.some((entry) => entry.source === source)) throw new Error(`COMBINATION_BROWSER_CASE_MISSING: ${source}`);
  }
  return selected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [planPath, summaryPath] = process.argv.slice(2);
  const [plan, summary] = await Promise.all([planPath, summaryPath].map(async (path) => JSON.parse(await readFile(path, "utf8"))));
  validatePlan(plan);
  if (summary.planDigest !== plan.digest) throw new Error("COMBINATION_BROWSER_PLAN_MISMATCH");
  const report = reconcileCombinationBrowserEvidence(await loadCombinationJourneys(root), plan, summary.results);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "PASS" ? 0 : 1;
}
