// F10 assemble-backend: stage the packaged payload tree for electron-builder.
//
// Inputs (all optional, defaults follow the dev checkout):
//   --repo   ../sciencediscovery   (built: pnpm build ran, venvs provisioned)
//   --data   <repo>/.sciencediscovery-data
//   --out    build/resources
//
// Output layout (consumed by shell/src/bootstrap.ts and electron-builder.yml):
//   <out>/backend            repo-relative runtime subset (repoRoot at runtime)
//   <out>/envs-template      the 5 venvs (pyvenv.cfg home + editable .pth fixed
//                            at first run by the shell)
//   <out>/python             the uv-managed base interpreter (venv `home` target)
//   <out>/micromamba         pinned micromamba.exe
//   <out>/version.json       payload manifest (commit, sizes, sha256)
//
// node_modules strategy (v4): `pnpm deploy` produces a self-contained
// prod install whose .pnpm store holds every package as REAL files with
// junction edges. We flatten that store into a classic npm-style
// <backend>/node_modules: every package as a real directory, package-internal
// node_modules stripped (flat resolution), and nested copies ONLY for
// multi-version conflicts. No junctions survive → the tree is portable.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { replaceVenvTrampolines, copyVenvRuntimeDlls } from "./lib/venv-launchers.mjs";

const shellRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : fallback;
}

const repo = arg("repo", join(shellRoot, "..", "sciencediscovery"));
const data = arg("data", join(repo, ".sciencediscovery-data"));
const out = arg("out", join(shellRoot, "build", "resources"));

const VENV_NAMES = ["gateway", "memory-graph", "evolve", "adapter", "paper"];
/** Placeholder bootstrap.ts substitutes with the real <resources>\backend. */
const BACKEND_PLACEHOLDER = "@@SD_BACKEND_ROOT@@";

const say = (line) => console.log(`[assemble] ${line}`);
const fail = (line) => { console.error(`[assemble] FAIL: ${line}`); process.exit(1); };

function pyvenvHome(venvDir) {
  const text = readFileSync(join(venvDir, "pyvenv.cfg"), "utf8");
  const match = /^home\s*=\s*(.+)$/m.exec(text);
  if (!match) fail(`no 'home' in ${join(venvDir, "pyvenv.cfg")}`);
  return match[1].trim();
}

/** Recursively measure a directory in MB (best-effort, ignores errors). */
async function dirSizeMb(dir) {
  let total = 0;
  const walk = async (d) => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) { try { total += (await stat(p)).size; } catch { /* raced */ } }
    }
  };
  await walk(dir);
  return total / (1024 * 1024);
}

/** Copy filter factory: skip named excludes.  Bytecode (__pycache__ / .pyc) is
 * intentionally kept so the first-run precompile step can be a fast no-op. */
function pyFilter(extraExcludes = []) {
  return (src) => {
    const rel = relative(data, src);
    const parts = rel.split(/[\\/]/).filter(Boolean);
    return !parts.some((p) => extraExcludes.includes(p));
  };
}

// ---------------------------------------------------------------------------
// 1. Sanity checks — fail fast before any copy

say(`repo    = ${repo}`);
say(`data    = ${data}`);
say(`out     = ${out}`);

for (const p of [
  join(repo, "scripts", "start-stack.mjs"),
  join(repo, "scripts", "jiuwenswarm.mjs"),
  join(repo, "scripts", "lib", "stack-platform.mjs"),
  join(repo, "services", "api", "dist", "server.js"),
  join(repo, "services", "runner", "dist", "server.js"),
  join(repo, "services", "paper", "paper_worker.py"),
  join(repo, "apps", "web", "dist"),
  join(repo, "skills"),
  join(repo, "extensions_config.json"),
  join(data, "scientific-envs", "bin", "micromamba.exe"),
  join(data, "jiuwenswarm", "src", ".venv", "pyvenv.cfg"),
]) {
  if (!existsSync(p)) fail(`missing expected input: ${p}`);
}
for (const name of VENV_NAMES) {
  if (!existsSync(join(data, "envs", name, "pyvenv.cfg"))) {
    fail(`missing venv: ${join(data, "envs", name)}`);
  }
}

say("sanity checks passed");

// ---------------------------------------------------------------------------
// 1b. F10.6p: stale-dist gate. `pnpm deploy` ships each workspace package's
// compiled `dist/` as-is — it does NOT rebuild it. Editing TS and only
// typechecking (--noEmit) leaves dist/ stale and the payload silently
// carries old code (dist16's first build did exactly that: the F10.6p fixes
// were in src/, absent from the installer). Any first-party package whose
// src/ is newer than its dist/ fails the build, offender named.

const gateExclude = /\.test\.[cm]?tsx?$|\.fixture\./; // tests don't ship in dist
async function newestMtime(dir, exclude) {
  let newest = 0;
  const walk = async (d) => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && !(exclude && exclude.test(e.name))) {
        const m = (await stat(p)).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  await walk(dir);
  return newest;
}
{
  const stale = [];
  for (const group of ["services", "packages", "apps"]) {
    const groupDir = join(repo, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of await readdir(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const srcDir = join(groupDir, entry.name, "src");
      const distDir = join(groupDir, entry.name, "dist");
      if (!existsSync(srcDir) || !existsSync(distDir)) continue;
      const [srcNewest, distNewest] = await Promise.all([
        newestMtime(srcDir, gateExclude),
        newestMtime(distDir),
      ]);
      if (srcNewest > distNewest) stale.push(`${group}/${entry.name}`);
    }
  }
  if (stale.length) {
    fail(`stale dist/ — src newer than dist, pnpm deploy would ship old code: ${stale.join(", ")} `
      + `— rebuild first (e.g. npx tsc -p <package>/tsconfig.json)`);
  }
  say("stale-dist gate passed (services/packages/apps)");
}

// Fresh staging: a stale partial tree (e.g. an interrupted earlier run) must
// never leak into the payload.
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// ---------------------------------------------------------------------------
// 2. pnpm deploy — self-contained prod install of the api closure

const deployDir = join(shellRoot, "build", ".deploy-tmp");
await rm(deployDir, { recursive: true, force: true });
say(`deploying prod closure (pnpm deploy --legacy) into ${deployDir}`);
try {
  execFileSync(
    "corepack pnpm --filter=@sciencediscovery/api deploy --prod --legacy "
    + `"${deployDir}"`,
    { cwd: repo, shell: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
} catch (error) {
  fail(`pnpm deploy failed: ${error.stderr?.toString() || error.message}`);
}
if (!existsSync(join(deployDir, "node_modules", ".pnpm"))) {
  fail("pnpm deploy produced no .pnpm store");
}

// ---------------------------------------------------------------------------
// 3. Flatten .pnpm into <out>/backend/node_modules

const backendOut = join(out, "backend");
const nmOut = join(backendOut, "node_modules");
const pnpmStore = join(deployDir, "node_modules", ".pnpm");

/** Is this filesystem entry a junction/symlink? */
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** Enumerate real package dirs and junction edges inside a node_modules dir
 * (one level, expanding @scope/ dirs). Junctions report as neither directory
 * nor file in Dirent terms — the isLink check must come FIRST. */
async function scanNodeModules(dir, onReal, onEdge) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (isLink(p)) { onEdge(e.name, readlinkSync(p)); continue; }
    if (!e.isDirectory()) continue;
    if (e.name.startsWith("@")) {
      await scanNodeModules(p, (name, realDir) => onReal(`${e.name}/${name}`, realDir),
        (name, target) => onEdge(`${e.name}/${name}`, target));
    } else {
      onReal(e.name, p);
    }
  }
}

/** package name+version from a real package dir. */
function pkgIdentity(realDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(realDir, "package.json"), "utf8"));
    return { name: pkg.name, version: String(pkg.version ?? "0.0.0") };
  } catch {
    return { name: "", version: "0.0.0" };
  }
}

/** Parse a .pnpm key dir name into the package it owns: e.g.
 * 'body-parser@2.3.0' → 'body-parser', '@sciencediscovery+provenance@file+...'
 * → '@sciencediscovery/provenance'. */
function ownNameFromKey(key) {
  const at = key.startsWith("@") ? key.indexOf("@", 1) : key.indexOf("@");
  if (at <= 0) return null;
  return key.slice(0, at).replace("+", "/");
}

// key dir (under .pnpm) → own package {name, version, realDir}
const ownByKey = new Map();
// key dir → deps the key's package resolves through its junctions:
// [{name, version}] — read straight off each junction target's package.json.
const depsByKey = new Map();
// name → Map(version → realDir)   (first real dir wins; same version = same content)
const realDirs = new Map();

for (const key of await readdir(pnpmStore, { withFileTypes: true })) {
  if (!key.isDirectory() || key.name === "node_modules" || key.name.startsWith(".")) continue;
  const keyDir = join(pnpmStore, key.name);
  const knm = join(keyDir, "node_modules");
  if (!existsSync(knm)) continue;
  const ownName = ownNameFromKey(key.name);
  const reals = [];
  const depLinks = [];
  await scanNodeModules(knm,
    (name, realDir) => reals.push({ name, realDir }),
    (_name, target) => depLinks.push(target));
  for (const { name, realDir } of reals) {
    const { version } = pkgIdentity(realDir);
    if (!realDirs.has(name)) realDirs.set(name, new Map());
    if (!realDirs.get(name).has(version)) realDirs.get(name).set(version, realDir);
    if (name === ownName) ownByKey.set(key.name, { name, version, realDir });
  }
  depsByKey.set(key.name, depLinks.map((target) => pkgIdentity(target)));
}

// version conflicts: name → Set(versions)
const conflicts = [...realDirs.entries()]
  .filter(([, versions]) => versions.size > 1)
  .map(([name]) => name);

// primary version per name: the one with the most consumers; ties → first seen.
const consumerCount = new Map(); // `${name}@${version}` → count
for (const deps of depsByKey.values()) {
  for (const dep of deps) {
    const id = `${dep.name}@${dep.version}`;
    consumerCount.set(id, (consumerCount.get(id) ?? 0) + 1);
  }
}
const primaryOf = new Map(); // name → version
for (const [name, versions] of realDirs) {
  let best = null; let bestCount = -1;
  for (const version of versions.keys()) {
    const count = consumerCount.get(`${name}@${version}`) ?? 0;
    if (count > bestCount) { best = version; bestCount = count; }
  }
  primaryOf.set(name, best);
}

// install locations: `${name}@${version}` → absolute dirs (flat roots)
const locations = new Map();
for (const [name, versions] of realDirs) {
  const primary = primaryOf.get(name);
  locations.set(`${name}@${primary}`, [join(nmOut, ...name.split("/"))]);
}
// Non-primary versions nest under each consumer's own install locations.
// Conflicts are rare and shallow; iterate to a fixed point.
for (let round = 0; round < 5; round += 1) {
  let changed = false;
  for (const [consumerKey, deps] of depsByKey) {
    const own = ownByKey.get(consumerKey);
    if (!own) continue;
    const consumerLocs = locations.get(`${own.name}@${own.version}`);
    if (!consumerLocs) continue;
    for (const dep of deps) {
      if (primaryOf.get(dep.name) === dep.version) continue; // flat root already
      const id = `${dep.name}@${dep.version}`;
      const nested = consumerLocs.map((l) => join(l, "node_modules", ...dep.name.split("/")));
      const existing = locations.get(id) ?? [];
      const merged = [...new Set([...existing, ...nested])];
      if (merged.length !== existing.length) { locations.set(id, merged); changed = true; }
    }
  }
  if (!changed) break;
}

if (conflicts.length > 0) {
  say(`multi-version packages (nested under consumers): ${conflicts.join(", ")}`);
}

/** Copy a real package dir into a destination, dropping its internal
 * node_modules (flat layout) and any leftover links. */
const copyFlat = (realDir, dest) => cp(realDir, dest, {
  recursive: true,
  force: true,
  filter: (src) => {
    const rel = relative(realDir, src);
    if (!rel) return true;
    if (rel.split(/[\\/]/).includes("node_modules")) return false;
    return !isLink(src);
  },
});

say(`flattening ${[...realDirs.keys()].length} packages into backend/node_modules`);
let copied = 0;
for (const [name, versions] of realDirs) {
  for (const [version, realDir] of versions) {
    const dests = locations.get(`${name}@${version}`) ?? [];
    for (const dest of dests) {
      await mkdir(dirname(dest), { recursive: true });
      await copyFlat(realDir, dest);
      copied += 1;
    }
  }
}
say(`flattened ${copied} package copies`);

// Verify: every direct dep of the deployed api resolves in the flat root.
let missing = 0;
await scanNodeModules(join(deployDir, "node_modules"),
  (name) => {
    if (!existsSync(join(nmOut, ...name.split("/")))) {
      say(`MISSING direct dep in flat root: ${name}`);
      missing += 1;
    }
  },
  () => {},
);
if (missing > 0) fail(`${missing} direct deps missing after flatten`);

// ---------------------------------------------------------------------------
// 4. Backend static tree

const copySet = [
  { src: join(repo, "scripts", "start-stack.mjs"), dest: join(backendOut, "scripts", "start-stack.mjs") },
  { src: join(repo, "scripts", "jiuwenswarm.mjs"), dest: join(backendOut, "scripts", "jiuwenswarm.mjs") },
  { src: join(repo, "scripts", "swarm-patches.py"), dest: join(backendOut, "scripts", "swarm-patches.py") },
  // jiuwenswarm.mjs runs `swarm-patches.py apply/verify <src> <tag>` on every
  // cold start; the patch set lives in jiuwen_swarm/patches/<tag> relative to
  // the backend root — shipping the script without it kills the stack
  // (F10.6 bugfix: coworker first-run timeout root cause #2).
  { src: join(repo, "jiuwen_swarm", "patches"), dest: join(backendOut, "jiuwen_swarm", "patches") },
  { src: join(repo, "scripts", "lib", "stack-platform.mjs"), dest: join(backendOut, "scripts", "lib", "stack-platform.mjs") },
  { src: join(repo, "services", "api", "dist"), dest: join(backendOut, "services", "api", "dist") },
  { src: join(repo, "services", "api", "package.json"), dest: join(backendOut, "services", "api", "package.json") },
  { src: join(repo, "services", "runner", "dist"), dest: join(backendOut, "services", "runner", "dist") },
  { src: join(repo, "services", "runner", "package.json"), dest: join(backendOut, "services", "runner", "package.json") },
  { src: join(repo, "services", "runner", "workloads"), dest: join(backendOut, "services", "runner", "workloads") },
  { src: join(repo, "services", "paper", "paper_worker.py"), dest: join(backendOut, "services", "paper", "paper_worker.py") },
  { src: join(repo, "services", "paper", "pyproject.toml"), dest: join(backendOut, "services", "paper", "pyproject.toml") },
  { src: join(repo, "services", "paper", "uv.lock"), dest: join(backendOut, "services", "paper", "uv.lock") },
  { src: join(repo, "apps", "web", "dist"), dest: join(backendOut, "apps", "web", "dist") },
  { src: join(repo, "apps", "desktop", "dist"), dest: join(backendOut, "apps", "desktop", "dist") },
  { src: join(repo, "skills"), dest: join(backendOut, "skills") },
  { src: join(repo, "extensions_config.json"), dest: join(backendOut, "extensions_config.json") },
];
// The four Python sidecar services: their venvs' editable .pth files point at
// <backend>/services/<name>/src, so the source trees must ride along.
const svcFilter = (src) => {
  const parts = relative(repo, src).split(/[\\/]/).filter(Boolean);
  if (parts.some((p) => p === "tests" || p === ".venv" || p === ".pytest_cache"
    || p === "node_modules" || p === "__pycache__" || p === "tools")) return false;
  if (src.endsWith(".pyc")) return false;
  const top = parts[parts.length - 1];
  return !["README.md", ".gitignore", "pyrightconfig.json"].includes(top);
};
for (const name of ["gateway", "memory-graph", "evolve", "adapter"]) {
  await mkdir(join(backendOut, "services", name), { recursive: true });
  await cp(join(repo, "services", name), join(backendOut, "services", name), {
    recursive: true,
    force: true,
    filter: svcFilter,
  });
}
say("copying backend static tree (scripts/api/runner/paper/sidecars/web/skills)");
for (const { src, dest } of copySet) {
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 5. JiuwenSwarm src tree (backend/.sciencediscovery-data/jiuwenswarm/src)

const jwSrcOut = join(backendOut, ".sciencediscovery-data", "jiuwenswarm", "src");
const jwSrcIn = join(data, "jiuwenswarm", "src");

// F10.6o: ".git"/"docs" must only match at the copy ROOT (the project's own
// docs folder). pyFilter([".git", "docs", ...]) matched every path segment
// and silently stripped lark_oapi/api/docs and cyclopts/docs out of the
// bundled .venv — lark_oapi then failed to import at all (circular-import
// error on `from . import docs`), which took the feishu channel down with a
// NameError (P2CardActionTrigger) and an endless 60s channel retry loop.
// __pycache__/.pyc/ruff.exe stay any-depth excludes (ruff.exe is the venv's
// dev tool at .venv/Scripts/ruff.exe; no site-package ships a ruff.exe).
function jwSrcFilter(src) {
  const segs = relative(jwSrcIn, src).split(/[\\/]/).filter(Boolean);
  if (segs[segs.length - 1] === "ruff.exe") return false;
  // F10.6t: .doc_project_maintainer is a docs-generation mirror with
  // >260-char paths (it broke the uninstaller once and PowerShell
  // enumeration) and zero runtime value — dead weight, exclude at the root.
  return segs[0] !== ".git" && segs[0] !== "docs" && segs[0] !== ".doc_project_maintainer";
}

say(`copying JiuwenSwarm src (minus top-level .git/docs) into backend tree`);
await mkdir(jwSrcOut, { recursive: true });
await cp(jwSrcIn, jwSrcOut, {
  recursive: true,
  force: true,
  filter: jwSrcFilter,
});

// Rewrite the setuptools editable finder so package paths resolve relative to
// wherever the payload got installed (site-packages → .venv → src).
const finderGlob = /^(?:__editable___.*_finder\.py)$/;
const sitePackages = join(jwSrcOut, ".venv", "Lib", "site-packages");
for (const e of await readdir(sitePackages, { withFileTypes: true })) {
  if (!e.isFile() || !finderGlob.test(e.name)) continue;
  const file = join(sitePackages, e.name);
  const text = await readFile(file, "utf8");
  const mappingLine = /^MAPPING: dict\[str, str\] = \{.*\}$/m.exec(text);
  if (!mappingLine) { say(`warning: no MAPPING line in ${e.name}; left as-is`); continue; }
  const entries = [...mappingLine[0].matchAll(/'([^']+)':\s*'([^']+)'/g)];
  if (entries.length === 0) { say(`warning: empty MAPPING in ${e.name}; left as-is`); continue; }
  const rewritten = entries.map(([, pkg, abs]) => {
    const tail = relative(jwSrcIn, abs).split(/[\\/]+/).filter(Boolean);
    if (tail.length === 0) fail(`editable mapping for ${pkg} does not live under the jw src tree`);
    return `'${pkg}': str(_SRC.joinpath(${tail.map((t) => `'${t}'`).join(", ")}))`;
  }).join(", ");
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => /^MAPPING: dict\[str, str\] = /.test(l));
  lines.splice(idx, 1, "_SRC = Path(__file__).resolve().parents[3]", `MAPPING: dict[str, str] = {${rewritten}}`);
  await writeFile(file, lines.join("\n"), "utf8");
  say(`rewrote editable finder ${e.name} (paths now resolve relative to the payload)`);
}

// ---------------------------------------------------------------------------
// 6. envs-template — the 5 venvs, editable .pth paths → placeholder

say("copying venv template (envs-template)");
for (const name of VENV_NAMES) {
  await cp(join(data, "envs", name), join(out, "envs-template", name), {
    recursive: true,
    force: true,
    filter: pyFilter(),
  });
  // _editable_impl_*.pth contains an absolute path into the dev repo; swap the
  // repo prefix for the placeholder the shell resolves at first run.
  const sp = join(out, "envs-template", name, "Lib", "site-packages");
  if (!existsSync(sp)) continue;
  for (const e of await readdir(sp, { withFileTypes: true })) {
    if (!e.isFile() || !/^_editable_impl_.*\.pth$/.test(e.name)) continue;
    const file = join(sp, e.name);
    const text = (await readFile(file, "utf8")).trim();
    if (!text.startsWith(repo)) { say(`warning: ${name}/${e.name} does not point into the repo; left as-is`); continue; }
    const tail = text.slice(repo.length).replace(/^[\\/]+/, "").replace(/\//g, "\\");
    await writeFile(file, `${BACKEND_PLACEHOLDER}\\${tail}\n`, "utf8");
    say(`placeholdered ${name}/${e.name}`);
  }
}

// ---------------------------------------------------------------------------
// 7. Base interpreter (venv `home`), realpath'd (uv dirs can be symlinks)

const pythonHome = await realpath(pyvenvHome(join(data, "envs", "gateway")));
if (!existsSync(join(pythonHome, "python.exe"))) fail(`no python.exe under ${pythonHome}`);
say(`copying base interpreter from ${pythonHome}`);
await cp(pythonHome, join(out, "python"), { recursive: true, force: true, filter: pyFilter() });

// ---------------------------------------------------------------------------
// 7b. [windows-desktop] F10.6m —— uv venv 的 Scripts\python.exe / pythonw.exe
// 是烧录了构建机解释器路径的 trampoline，装机即 "entity not found"（外机
// dist7-12 全灭根因）。载荷侧就地换成第 7 步拷入的真解释器；bootstrap
// 首启还有一层幂等兜底（防同位置重装时 dataDir\envs 留旧 trampoline）。

say("replacing uv trampoline launchers in bundled venvs");
const launcherDirs = [
  ...VENV_NAMES.map((name) => join(out, "envs-template", name)),
  join(out, "backend", ".sciencediscovery-data", "jiuwenswarm", "src", ".venv"),
];
const launcherReplaced = await replaceVenvTrampolines(launcherDirs, join(out, "python"), say);
if (launcherReplaced === 0) {
  fail("no uv trampoline launchers found in the bundled venvs — the payload layout changed (or the venvs are no longer uv-made); investigate before shipping");
}
say(`replaced ${launcherReplaced} trampoline launcher(s)`);

// F10.6r/t: the shell launches the whole stack with hidden consoles; every
// payload Python that spawns a console-subsystem child without
// CREATE_NO_WINDOW flashes a blank cmd window (field 2026-10-19: init-phase
// flashes from execFile'd jw CLI steps, and tool/agent runs would flash from
// the service venvs). Each venv gets a sitecustomize that patches subprocess
// defaults (activated by SCIENCE_AGENT_DESKTOP, which start-stack sets for
// the whole tree). All six payload venvs — jw + envs-template ×5. Source of
// truth stays in the repo; the dev venvs are never touched.
const sitecustomizeSrc = join(repo, "scripts", "desktop-venv-sitecustomize.py");
let sitecustomizeCount = 0;
for (const venvRoot of launcherDirs) {
  const venvSitePackages = join(venvRoot, "Lib", "site-packages");
  if (!existsSync(venvSitePackages)) {
    fail(`no site-packages under ${relative(out, venvRoot)} — the venv layout changed; investigate before shipping`);
  }
  await copyFile(sitecustomizeSrc, join(venvSitePackages, "sitecustomize.py"));
  sitecustomizeCount += 1;
}
say(`installed desktop sitecustomize (subprocess CREATE_NO_WINDOW guard) into ${sitecustomizeCount} payload venv(s)`);

// [windows-desktop] F10.6n —— 换上的真 exe 按名字解析 python3x.dll/
// vcruntime*.dll：exe 自身目录 → PATH → 注册表。干净机器上兜底全空，
// 进程在 main() 之前就以 0xC0000135 秒退（dist13 外机实测：六个 venv
// python 全灭，precompile 0-1s ×6，jw init 1.6s）。构建机 PATH 里恰好
// 有别的 Python，酸测掩盖了它。运行时 DLL 必须随 launcher 一起进
// venv\Scripts\，exe 目录一次命中。
say("installing runtime DLLs beside the bundled venv launchers");
const dllCopies = await copyVenvRuntimeDlls(launcherDirs, join(out, "python"), say);
if (dllCopies === 0) {
  fail("no runtime DLLs installed beside the venv launchers — expected python3x.dll + vcruntime*.dll in the bundled python root; investigate before shipping");
}
say(`installed ${dllCopies} runtime DLL file(s) beside venv launchers`);

// ---------------------------------------------------------------------------
// 7c. Eagerly precompile bytecode so the first-run bootstrap compileall is a
// no-op. checked-hash (PEP 552): validity keys on the source CONTENT hash, so
// downstream copy chains (electron-builder → NSIS → dataDir) may restamp
// mtimes freely without invalidating what we ship.
say("precompiling Python bytecode for bundled venvs");
const compileEnv = { ...process.env, PYTHONWARNINGS: "ignore" };
const compileAll = (pythonExe, target) =>
  execFileSync(pythonExe, ["-m", "compileall", "-q", "--invalidation-mode", "checked-hash", target], { env: compileEnv, windowsHide: true, stdio: "pipe" });
const basePythonExe = join(out, "python", "python.exe");
const jwVenvPython = join(out, "backend", ".sciencediscovery-data", "jiuwenswarm", "src", ".venv", "Scripts", "python.exe");
const compileTargets = [
  { label: "python stdlib", python: basePythonExe, path: join(out, "python", "Lib") },
  ...VENV_NAMES.map(name => ({ label: `venv ${name}`, python: basePythonExe, path: join(out, "envs-template", name, "Lib", "site-packages") })),
  // jw's venv compiles with ITS OWN interpreter (site-packages + the editable
  // src mount both resolve through it; the base python failed on this pair).
  { label: "jiuwenswarm venv", python: jwVenvPython, path: join(out, "backend", ".sciencediscovery-data", "jiuwenswarm", "src", ".venv", "Lib", "site-packages") },
  { label: "jiuwenswarm src", python: jwVenvPython, path: join(out, "backend", ".sciencediscovery-data", "jiuwenswarm", "src") },
];
for (const { label, python, path: target } of compileTargets) {
  if (!existsSync(target)) continue;
  try {
    compileAll(python, target);
    say(`precompiled bytecode for ${label}`);
  } catch (error) {
    say(`warning: bytecode precompile skipped for ${label}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// 8. micromamba

say("copying micromamba");
await mkdir(join(out, "micromamba"), { recursive: true });
await cp(join(data, "scientific-envs", "bin", "micromamba.exe"),
  join(out, "micromamba", "micromamba.exe"), { force: true });

// ---------------------------------------------------------------------------
// 9. version.json manifest

let repoCommit = "unknown";
try {
  repoCommit = execFileSync("git rev-parse HEAD", { cwd: repo, shell: true, encoding: "utf8" }).trim();
} catch { /* not a git checkout — keep "unknown" */ }

const pieces = {};
for (const name of ["backend", "envs-template", "python", "micromamba"]) {
  pieces[name] = Math.round((await dirSizeMb(join(out, name))) * 10) / 10;
}
const mmBuf = readFileSync(join(out, "micromamba", "micromamba.exe"));
const manifest = {
  repoCommit,
  builtAt: new Date().toISOString(),
  piecesMB: pieces,
  micromambaSha256: createHash("sha256").update(mmBuf).digest("hex"),
};
await writeFile(join(out, "version.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

// ---------------------------------------------------------------------------
// 10. Cleanup + report

await rm(deployDir, { recursive: true, force: true });
say("removed deploy temp dir");
say(`done — payload pieces (MB): ${JSON.stringify(pieces)}`);
