import { readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSourceTestMap } from "./source-test-map.mjs";

import { classifySource, isInventorySource, sourceRoots } from "./source-scope.mjs";

const ROOT = process.cwd();

async function walk(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(absolute));
    else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) result.push(absolute);
  }
  return result;
}

function classify(source) {
  if (/^services\/api\/src\/http\//u.test(source) || /^apps\/(?:web|desktop)\/src\/(?:views\/|components\/)/u.test(source)) return "P1";
  if (/^services\/runner\/src\//u.test(source) || /^packages\/(?:execution-router|mcp|data-source|operational-logging|specialist|skill|memory|provenance|artifact-manager|governance)\/src\//u.test(source)) return "P1";
  return "P2";
}

export async function buildSourceInventory(root = ROOT) {
  const map = await loadSourceTestMap(root);
  const mapped = new Map(map.entries.map((entry) => [entry.source, entry]));
  const files = (await Promise.all(sourceRoots.map((path) => walk(join(root, path))))).flat()
    .map((path) => relative(root, path).replaceAll("\\", "/"))
    .filter(isInventorySource)
    .sort();
  return files.map((source) => {
    const entry = mapped.get(source);
    return {
      source,
      risk: entry?.risk ?? classify(source),
      owner: entry?.owner ?? "unassigned",
      mapped: Boolean(entry),
      testEvidence: entry?.tests?.length ?? 0,
      waiver: entry?.waiver ?? null,
      classification: classifySource(root, source),
    };
  });
}

export async function writeSourceInventory(root = ROOT, output = resolve(root, ".ci-results", "source-test-inventory.json")) {
  const inventory = await buildSourceInventory(root);
  const summary = {
    generatedAt: new Date().toISOString(),
    sourceRoots,
    total: inventory.length,
    mapped: inventory.filter((item) => item.mapped).length,
    unmapped: inventory.filter((item) => !item.mapped).length,
    highRiskUnmapped: inventory.filter((item) => !item.mapped && (item.risk === "P0" || item.risk === "P1") && item.classification === "behavioral").length,
    entries: inventory,
  };
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, ".ci-results"), { recursive: true });
  await writeFile(output, `${JSON.stringify(summary, null, 2)}
`);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = await writeSourceInventory();
  console.log(`Source inventory written: ${summary.total} source files, ${summary.mapped} mapped, ${summary.highRiskUnmapped} high-risk behavioral files without evidence`);
  process.exitCode = summary.highRiskUnmapped > 0 && process.env.CI_ENFORCE_SOURCE_INVENTORY === "1" ? 1 : 0;
}
