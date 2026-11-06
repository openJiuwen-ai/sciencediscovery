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

/**
 * Builds the workspace packages an app imports from their `dist/` entry.
 *
 * An app whose tests run straight from source with `tsx` still imports its
 * sibling workspace packages through their `package.json` `exports`, and those
 * point at `dist/`. On a clean tree those directories do not exist yet — the
 * repo's own `pnpm test` builds everything first — so a package-level
 * `tsx --test` run dies with ERR_MODULE_NOT_FOUND for each such import.
 *
 * This walks the app's workspace dependencies and builds the ones whose output
 * is missing. It is a no-op once they are built, so the CI path that already
 * ran `pnpm build` pays only a directory listing here.
 *
 * Usage: node scripts/ensure-workspace-dist.mjs <app-directory>
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = resolve(process.argv[2] ?? ".");
const WORKSPACE_GLOBS = ["config", "apps", "services", "packages"];

/** Every directory the workspace owns, keyed by package name. */
function workspacePackages() {
  const byName = new Map();
  for (const group of WORKSPACE_GLOBS) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    const dirs = group === "config" ? [base] : [base, ...readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(base, entry.name))];
    for (const dir of dirs) {
      const manifest = join(dir, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name) byName.set(pkg.name, { dir, pkg });
    }
  }
  return byName;
}

/** The app's workspace dependencies, transitively, dependencies before dependents. */
function closure(appPackage, byName) {
  const ordered = [];
  const seen = new Set();
  const visit = (pkg) => {
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      if (seen.has(dep) || !byName.has(dep)) continue;
      seen.add(dep);
      visit(byName.get(dep).pkg);
      ordered.push(dep);
    }
  };
  visit(appPackage);
  return ordered;
}

const byName = workspacePackages();
const app = byName.get(JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).name);
if (!app) throw new Error(`${appDir} is not a workspace package`);

const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const built = [];
for (const name of closure(app.pkg, byName)) {
  const entry = byName.get(name);
  if (existsSync(join(entry.dir, "dist"))) continue;
  const tsconfig = join(entry.dir, "tsconfig.json");
  if (!existsSync(tsconfig)) continue;
  const run = spawnSync(process.execPath, [tsc, "-p", tsconfig], { cwd: entry.dir, encoding: "utf8" });
  if (run.status !== 0) {
    process.stderr.write(run.stdout ?? "");
    process.stderr.write(run.stderr ?? "");
    process.exit(run.status ?? 1);
  }
  built.push(name);
}
if (built.length > 0) console.log(`built workspace packages without dist: ${built.join(", ")}`);
