import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadSourceTestMap } from "./source-test-map.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const headIndex = args.indexOf("--head");
const base = baseIndex >= 0 ? args[baseIndex + 1] : process.env.CI_BASE_SHA;
const head = headIndex >= 0 ? args[headIndex + 1] : process.env.CI_HEAD_SHA;
const optionValueIndexes = new Set();
if (baseIndex >= 0) { optionValueIndexes.add(baseIndex); optionValueIndexes.add(baseIndex + 1); }
if (headIndex >= 0) { optionValueIndexes.add(headIndex); optionValueIndexes.add(headIndex + 1); }
const explicitPaths = args.filter((value, index) => value && !optionValueIndexes.has(index) && !value.startsWith("--"));
let changed = explicitPaths;
if (!changed.length && base && head) {
  const diff = spawnSync("git", ["diff", "--name-only", base, head], { cwd: root, encoding: "utf8" });
  if (diff.status !== 0) throw new Error(`Unable to compare ${base}..${head}: ${diff.stderr || diff.status}`);
  changed = diff.stdout.split(/\r?\n/u).filter(Boolean);
}
const normalized = changed.map((path) => path.replaceAll("\\", "/"));
const map = await loadSourceTestMap(root);
const bySource = new Map(map.entries.map((entry) => [entry.source, entry]));
const candidates = normalized.filter((path) => /^(apps\/(web|desktop)\/src\/|services\/api\/src\/http\/|packages\/)/.test(path) && /\.(ts|tsx)$/.test(path) && !/(?:^|\.)(?:test|spec)\.[^.]+$/.test(path));
const missing = candidates.filter((path) => !bySource.has(path));
const expired = map.entries.filter((entry) => entry.waiver?.expiry && entry.waiver.expiry < new Date().toISOString().slice(0, 10));
for (const entry of map.entries) {
  if (entry.waiver && (!entry.waiver.owner || !entry.waiver.expiry)) expired.push(entry);
}
if (!existsSync(join(root, "test", "source-test-map.json"))) throw new Error("source-test-map.json is missing");
const enforce = process.env.CI_ENFORCE_SOURCE_MAP === "1";
const problems = [...new Set([...missing.map((path) => `changed high-risk source has no test mapping: ${path}`), ...expired.map((entry) => `expired or incomplete waiver: ${entry.source}`)])];
if (problems.length && enforce) {
  console.error(`Changed-path source-test policy failed:\n- ${problems.join("\n- ")}`);
  process.exitCode = 1;
} else {
  if (problems.length) console.warn(`Changed-path source-test policy warning:\n- ${problems.join("\n- ")}`);
  console.log(`Changed-path source-test policy OK: ${candidates.length - missing.length}/${candidates.length} mapped`);
}
