// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const metrics = new Set(["benchmark-metrics.json", "team-metrics.json", "evolve-metrics.json"]);
const planFiles = new Set(["plan.json", "summary.json", "preflight.json"]);

// Metrics embed prompts, delivery text and judge transcripts in the diagnostic
// copy. Project only the fields consumed by the dashboard, in the same shape.
const pick = (doc, fields) => Object.fromEntries(fields.filter(key => doc?.[key] !== undefined)
  .map(key => [key, doc[key]]));
function scoreFields(doc) {
  const out = {};
  if (typeof doc?.status === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(doc.status)) out.status = doc.status;
  if (typeof doc?.gating === "boolean") out.gating = doc.gating;
  for (const key of ["score", "total_score", "baseline_gate_score", "best_gate_score", "overall_score",
    "citation_accuracy", "verification_coverage", "effective_citations"]) {
    if (doc?.[key] === null || (typeof doc?.[key] === "number" && Number.isFinite(doc[key]))) out[key] = doc[key];
  }
  for (const key of ["race", "fact"]) if (doc?.[key] && typeof doc[key] === "object") out[key] = scoreFields(doc[key]);
  return out;
}
function scoreDocument(doc, name) {
  if (!doc || Array.isArray(doc) || typeof doc !== "object") throw new SyntaxError("Expected an object");
  if (metrics.has(name)) {
    const out = pick(doc, ["schema_version", "case", "case_id", "integration_status", "integration",
      "started_at", "finished_at", "generation_duration_ms"]);
    for (const key of ["evaluation", "llm_evaluation"]) {
      if (doc[key] && typeof doc[key] === "object") out[key] = scoreFields(doc[key]);
    }
    return out;
  }
  if (name === "summary.json") {
    const out = pick(doc, ["status", "exitCode", "planDigest", "planned", "reported", "executed", "passed", "failed", "skipped"]);
    if (Array.isArray(doc.results)) out.results = doc.results.map(result => pick(result, ["key", "outcome", "actualTarget"]));
    return out; // Assertion errors/problems may contain model output or credentials.
  }
  // Frozen plan and structured preflight contain source identities/requirements,
  // not model calls; retain the plan fields so its digest stays valid.
  return doc;
}

// Stage only regular files; diagnostics, similarly named files and symlinks
// cannot enter the score artifact. Preserve relative paths for the collector.
export async function prepareRealE2EResults(root = process.cwd()) {
  const source = resolve(root, ".ci-results");
  const output = resolve(root, ".tmp", "real-e2e-results");
  await rm(output, { force: true, recursive: true });
  await mkdir(output, { recursive: true });
  const files = [];
  async function visit(relative = "") {
    let entries;
    try {
      entries = await readdir(join(source, relative), { withFileTypes: true });
    } catch (error) {
      // Preparation may have failed before producing any results. Leave an
      // empty directory so upload-artifact's if-no-files-found can warn.
      if (error.code === "ENOENT" && !relative) return;
      throw error;
    }
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && (metrics.has(basename(path))
          || (relative === "e2e-real/tagged" && planFiles.has(entry.name)))) {
        let doc;
        try {
          doc = scoreDocument(JSON.parse(await readFile(join(source, path), "utf8")), entry.name);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          // Never echo malformed JSON: Node's parser error can include its contents.
          console.warn("Skipping an invalid real E2E score/plan JSON; original retained in evidence.");
          continue;
        }
        const destination = join(output, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, JSON.stringify(doc, null, 2) + "\n");
        files.push(path);
      }
    }
  }
  await visit();
  return files.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await prepareRealE2EResults();
  console.log(`Staged ${files.length} real E2E score/plan files.`);
}
