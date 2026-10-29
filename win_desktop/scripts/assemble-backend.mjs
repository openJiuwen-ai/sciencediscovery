// assemble-backend: stage the packaged payload tree for electron-builder.
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
import { makeJwSrcFilter } from "./lib/jw-src-filter.mjs";

const shellRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : fallback;
}

// The backend tree to package. In-tree default: this repository itself
// (win_desktop/ lives at the repo root). Pass --repo <path> to package an
// out-of-tree backend checkout instead.
const repo = arg("repo", join(shellRoot, ".."));
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
// 1b. Stale-dist gate. `pnpm deploy` ships each workspace package's
// compiled `dist/` as-is — it does NOT rebuild it. Editing TS and only
// typechecking (--noEmit) leaves dist/ stale and the payload silently
// carries old code (a real incident: fixes landed in src/ but were absent
// from the installer). Any first-party package whose
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
// corepack only ships as a .cmd shim on Windows, which a shell-less
// execFileSync cannot run (Node deliberately refuses to spawn .cmd files
// without a shell). The command stays a fixed string and the one
// interpolated value — deployDir, derived from this script's own location —
// is validated against shell metacharacters, so nothing user-controlled
// can ever reach the command line.
if (/[&^%"<>|]/.test(deployDir)) {
  fail(`deploy path contains shell metacharacters, refusing to build a command line from it: ${deployDir}`);
}
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
  // (field bugfix: coworker first-run timeouts traced back to this).
  { src: join(repo, "jiuwen_swarm", "patches"), dest: join(backendOut, "jiuwen_swarm", "patches") },
  { src: join(repo, "scripts", "lib", "stack-platform.mjs"), dest: join(backendOut, "scripts", "lib", "stack-platform.mjs") },
  { src: join(repo, "services", "api", "dist"), dest: join(backendOut, "services", "api", "dist") },
  { src: join(repo, "services", "api", "package.json"), dest: join(backendOut, "services", "api", "package.json") },
  { src: join(repo, "services", "runner", "dist"), dest: join(backendOut, "services", "runner", "dist") },
  { src: join(repo, "services", "runner", "package.json"), dest: join(backendOut, "services", "runner", "package.json") },
  { src: join(repo, "services", "runner", "workloads"), dest: join(backendOut, "services", "runner", "workloads") },
  // Field report ("missing its Linux arm64 Runner SEA
  // artifact"): executor's loadRunnerExecutable resolves the
  // @sciencediscovery/runner package ENTRY (exports ./dist/index.js) and reads
  // sea/linux-<arch>/ from that dirname — i.e. the node_modules package
  // layout. An earlier build shipped the SEA under services/runner/dist/sea (the
  // build-runner.mjs OUTPUT layout), which nothing reads at runtime; the
  // entry below copies it to the layout remote-host deployment actually
  // resolves, and the rm below drops the dead duplicate from the payload.
  { src: join(repo, "services", "runner", "dist", "sea"), dest: join(backendOut, "node_modules", "@sciencediscovery", "runner", "dist", "sea") },
  { src: join(repo, "services", "paper", "paper_worker.py"), dest: join(backendOut, "services", "paper", "paper_worker.py") },
  { src: join(repo, "services", "paper", "pyproject.toml"), dest: join(backendOut, "services", "paper", "pyproject.toml") },
  { src: join(repo, "services", "paper", "uv.lock"), dest: join(backendOut, "services", "paper", "uv.lock") },
  { src: join(repo, "apps", "web", "dist"), dest: join(backendOut, "apps", "web", "dist") },
  { src: join(repo, "apps", "desktop", "dist"), dest: join(backendOut, "apps", "desktop", "dist") },
  { src: join(repo, "skills"), dest: join(backendOut, "skills") },
  { src: join(repo, "extensions_config.json"), dest: join(backendOut, "extensions_config.json") },
  // Field report (the built-in UniProt source was unavailable): uniprot_mcp.py reads
  // external URLs at IMPORT time from cwd()/config/external-urls.json (or
  // SCIENCE_AGENT_EXTERNAL_URLS_PATH) — neither existed in the packaged
  // backend (only the node_modules copy the Node api imports), so the stdio
  // subprocess died before the MCP handshake and the source showed
  // "unavailable". Ship the repo's authoritative config to backend/config/.
  { src: join(repo, "config", "external-urls.json"), dest: join(backendOut, "config", "external-urls.json") },
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
// The services/runner/dist entry above drags the SEA output
// dir into the payload (build-runner.mjs writes there); runtime readers use
// the node_modules layout copied separately, so drop the duplicate here.
await rm(join(backendOut, "services", "runner", "dist", "sea"), { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 5. JiuwenSwarm src tree (backend/.sciencediscovery-data/jiuwenswarm/src)

const jwSrcOut = join(backendOut, ".sciencediscovery-data", "jiuwenswarm", "src");
const jwSrcIn = join(data, "jiuwenswarm", "src");

// The filter-rule lessons live with the rules themselves:
// scripts/lib/jw-src-filter.mjs (unit-tested in test/jw-src-filter.test.ts).
// Field incident: frontend/node_modules (329.5 MB) shipped — the filter now
// excludes node_modules at any depth.
const jwSrcFilter = makeJwSrcFilter(jwSrcIn);

say(`copying JiuwenSwarm src (minus top-level .git/docs) into backend tree`);
await mkdir(jwSrcOut, { recursive: true });
await cp(jwSrcIn, jwSrcOut, {
  recursive: true,
  force: true,
  filter: jwSrcFilter,
});

// Lesson: fs.cp --force OVERLAYS the target — files that an older
// build copied before a filter rule existed (or that the filter now excludes)
// stay behind forever and keep shipping in every installer. Sweep the known
// dead weight out of the target tree after the copy so the payload reflects
// the filter, not the history of this build directory.
async function rmIfPresent(p) {
  try { await rm(p, { recursive: true, force: true }); say(`swept stale payload: ${relative(jwSrcOut, p)}`); }
  catch { /* best effort */ }
}
for (const junk of ["htmlcov", "coverage.xml", ".coverage", ".pytest_cache"]) {
  await rmIfPresent(join(jwSrcOut, junk));
}
async function sweepPycache(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === "__pycache__") { await rmIfPresent(join(dir, e.name)); continue; }
    if (e.isDirectory()) await sweepPycache(join(dir, e.name));
  }
}
await sweepPycache(join(jwSrcOut, "tests"));

// Sweep-backstop for node_modules: the filter rule alone only
// protects fresh copies — anything already sitting in the output tree from a
// build that predated the rule must go too. .venv is skipped (a Python venv
// never contains node_modules; skipping keeps the sweep off the 1.2 GB tree).
async function sweepNodeModules(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === ".venv") continue;
    if (e.name === "node_modules" && e.isDirectory()) {
      await rmIfPresent(join(dir, e.name));
      continue;
    }
    if (e.isDirectory()) await sweepNodeModules(join(dir, e.name));
  }
}
await sweepNodeModules(jwSrcOut);

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
    const rel = relative(jwSrcIn, abs);
    // Field incident (stale editable venv): a venv carried over from a moved
    // checkout still mapped into the old absolute path; relative() happily
    // produced a ".." hop chain that resolved nowhere on the installed
    // machine, and the payload shipped with every jw import dead. Anything
    // not strictly inside the jw src tree is a broken payload.
    if (rel === "" || rel.startsWith("..") || /^[a-zA-Z]:[\\/]/.test(rel)) {
      fail(`editable mapping for ${pkg} does not live under the jw src tree (mapped to ${abs}); the bundled venv's editable install is stale — reinstall it from this tree before assembling`);
    }
    const tail = rel.split(/[\\/]+/).filter(Boolean);
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
    // Field incident (stale editable venv): the envs came from a data dir
    // carried over after a repo migration; their .pth files still pointed at
    // the old checkout path. This branch only warned and shipped anyway, and
    // every Python sidecar died with ModuleNotFoundError on the installed
    // machine while the build machine looked healthy. A mispointed editable
    // is always a broken payload — fail the build instead of shipping it.
    // A directory boundary must follow the repo prefix: `repo` is also a
    // prefix of `repo-something-else`, and that sibling path would silently
    // slice into a wrong tail (e.g. `-something-else\...`) instead of failing.
    if (!text.startsWith(repo) || !/^[\\/]/.test(text.slice(repo.length))) {
      fail(`${name}/${e.name} points outside the repo (${text}) — the venv's editable install is stale; reinstall the editable packages from this repo before assembling`);
    }
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
// 7b. [windows-desktop] uv venv Scripts\python.exe / pythonw.exe are
// trampolines with the build machine's interpreter path burned in — on any
// other machine spawn dies with "entity not found" (the root cause of every
// off-machine failure). The payload side swaps them in place with the real
// interpreter copied in step 7; bootstrap adds an idempotent first-run
// backstop (a same-location reinstall can leave old trampolines in
// dataDir\envs).

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

// The shell launches the whole stack with hidden consoles; every
// payload Python that spawns a console-subsystem child without
// CREATE_NO_WINDOW flashes a blank cmd window (observed in the field:
// init-phase flashes from execFile'd jiuwenswarm CLI steps, and tool/agent
// runs would flash from the service venvs). Each venv gets a sitecustomize
// that patches subprocess defaults (activated by SCIENCE_AGENT_DESKTOP,
// which start-stack sets for the whole tree). All six payload venvs —
// jiuwenswarm + envs-template ×5. Source of
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

// [windows-desktop] The swapped-in real exe resolves python3x.dll/
// vcruntime*.dll by name: its own directory → PATH → registry. On a clean
// machine every fallback is empty and the process exits with 0xC0000135
// before main() (measured off-machine: six dead venv pythons, precompile
// 0-1s ×6, jiuwenswarm init 1.6s). An unrelated Python on the build
// machine's PATH masked it during local testing. The runtime DLLs must ride
// along with the launcher into venv\Scripts\ so the exe directory hits first.
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
const compileAll = (pythonExe, target, exclude) =>
  execFileSync(pythonExe, ["-m", "compileall", "-q", "--invalidation-mode", "checked-hash",
    ...(exclude ? ["-x", exclude] : []), target], { env: compileEnv, windowsHide: true, stdio: "pipe" });
const basePythonExe = join(out, "python", "python.exe");
const jwVenvPython = join(out, "backend", ".sciencediscovery-data", "jiuwenswarm", "src", ".venv", "Scripts", "python.exe");
const compileTargets = [
  { label: "python stdlib", python: basePythonExe, path: join(out, "python", "Lib") },
  ...VENV_NAMES.map(name => ({ label: `venv ${name}`, python: basePythonExe, path: join(out, "envs-template", name, "Lib", "site-packages") })),
  // jw's venv compiles with ITS OWN interpreter (site-packages + the editable
  // src mount both resolve through it; the base python failed on this pair).
  { label: "jiuwenswarm venv", python: jwVenvPython, path: join(out, "backend", ".sciencediscovery-data", "jiuwenswarm", "src", ".venv", "Lib", "site-packages") },
  // Lesson: compiling the WHOLE src tree also compiles tests/**, which
  // resurrects the very __pycache__ the post-copy sweep removed (~40 dirs of
  // dead weight that shipped in every installer). -x skips path
  // components named tests so the bytecode is never generated in the first
  // place; the post-compile sweep below is the belt-and-suspenders net.
  { label: "jiuwenswarm src", python: jwVenvPython, path: join(out, "backend", ".sciencediscovery-data", "jiuwenswarm", "src"), exclude: "[/\\\\]tests[/\\\\]" },
];
for (const { label, python, path: target, exclude } of compileTargets) {
  if (!existsSync(target)) continue;
  try {
    compileAll(python, target, exclude);
    say(`precompiled bytecode for ${label}`);
  } catch (error) {
    say(`warning: bytecode precompile skipped for ${label}: ${error.message}`);
  }
}
// Belt and suspenders: whatever re-created test bytecode above (regex misses,
// future code paths) gets swept here, after ALL compileall runs.
await sweepPycache(join(jwSrcOut, "tests"));

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
  repoCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
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
