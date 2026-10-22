// F10 packaged bootstrap: pure-decision tests. The IO path (bootstrapPackaged)
// copies trees and rewrites pyvenv.cfg lines — its building blocks are the
// functions under test here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bootstrapPackaged, compileallArgs, copyTreeConcurrent, needsUnpack, packagedEnv, packagedPaths, precompileTargets,
  rewriteEditablePth, rewritePyvenvHome, stampPath, treeHasPycache,
} from "../src/bootstrap.ts";
import { resolveRepoRoot } from "../src/config.ts";

// --- resolveRepoRoot: packaged vs dev ----------------------------------------

test("resolveRepoRoot prefers env, then packaged layout, then dev sibling", () => {
  assert.equal(resolveRepoRoot({ SD_SHELL_REPO: "E:\\custom" }, "C:\\shell"), "E:\\custom");
  assert.equal(resolveRepoRoot({ SD_SHELL_REPO: "E:\\custom" }, "C:\\shell", "C:\\res"), "E:\\custom");
  assert.equal(resolveRepoRoot({}, "C:\\shell", "C:\\res"), join("C:\\res", "backend"));
  assert.equal(resolveRepoRoot({}, "C:\\shell", null), join("C:\\shell", "..", "sciencediscovery"));
  assert.equal(resolveRepoRoot({}, "C:\\shell"), join("C:\\shell", "..", "sciencediscovery"));
});

// --- packagedPaths ------------------------------------------------------------

test("packagedPaths maps the installer layout", () => {
  const p = packagedPaths("C:\\Program Files\\SD\\resources");
  assert.equal(p.backend, join("C:\\Program Files\\SD\\resources", "backend"));
  assert.equal(p.python, join("C:\\Program Files\\SD\\resources", "python"));
  assert.equal(p.micromamba, join("C:\\Program Files\\SD\\resources", "micromamba", "micromamba.exe"));
  assert.equal(p.envsTemplate, join("C:\\Program Files\\SD\\resources", "envs-template"));
  assert.ok(p.venvNames.includes("gateway"));
  assert.ok(p.jwSrc.endsWith(join("jiuwenswarm", "src")));
});

// --- packagedEnv ---------------------------------------------------------------

test("packagedEnv injects the packaged-mode contract", () => {
  const p = packagedPaths("C:\\res");
  const env = packagedEnv(p, "D:\\data");
  assert.equal(env.SCIENCE_AGENT_PACKAGED, "1");
  assert.equal(env.SCIENCE_AGENT_PYTHON_PATH, join("C:\\res", "python", "python.exe"));
  assert.equal(env.SCIENCE_AGENT_PROVISIONER_PATH, join("C:\\res", "micromamba", "micromamba.exe"));
  // No PYTHONPYCACHEPREFIX: the payload's in-place __pycache__ must be used.
  assert.equal(env.PYTHONPYCACHEPREFIX, undefined);
  assert.equal(env.JIUWENSWARM_ROOT, join("D:\\data", "jiuwenswarm"));
  assert.equal(env.JIUWENSWARM_SRC, join("C:\\res", "backend", ".sciencediscovery-data", "jiuwenswarm", "src"));
  assert.equal(env.SCIENCE_AGENT_PAPER_PYTHON_PATH, join("D:\\data", "envs", "paper", "Scripts", "python.exe"));
});

// --- rewriteEditablePth --------------------------------------------------------

test("rewriteEditablePth swaps the backend placeholder", () => {
  const pth = "@@SD_BACKEND_ROOT@@\\services\\gateway\\src\n";
  assert.equal(rewriteEditablePth(pth, "C:\\install\\resources\\backend"),
    "C:\\install\\resources\\backend\\services\\gateway\\src\n");
  // No placeholder → untouched.
  assert.equal(rewriteEditablePth("C:\\already\\fixed\n", "C:\\x"), "C:\\already\\fixed\n");
});

// --- rewritePyvenvHome ---------------------------------------------------------

test("rewritePyvenvHome rewrites the home line, CRLF-safe", () => {
  const cfg = "home = C:\\Users\\dev\\AppData\\Local\\uv\\python\r\ninclude-system-site-packages = false\r\n";
  const fixed = rewritePyvenvHome(cfg, "C:\\install\\resources\\python");
  assert.ok(fixed.startsWith("home = C:\\install\\resources\\python\r\n"), fixed);
  assert.ok(fixed.includes("include-system-site-packages = false"));
});

test("rewritePyvenvHome adds a home line when absent", () => {
  const fixed = rewritePyvenvHome("version = 3.12\n", "C:\\py");
  assert.ok(fixed.startsWith("home = C:\\py\n"), fixed);
});

// --- needsUnpack / bootstrapPackaged (temp-dir IO) ------------------------------

test("compileallArgs pins the quiet content-hash compileall invocation for a target (F10.6d)", () => {
  const target = join("D:", "data", "envs", "gateway", "Lib", "site-packages");
  assert.deepEqual(compileallArgs(target),
    ["-m", "compileall", "-q", "--invalidation-mode", "checked-hash", target]);
});

// --- F10.6d2: precompile targets split by phase ----------------------------------

test("precompileTargets: before unpack only template-phase targets exist; after it the venvs appear", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sd-f10d2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, "resources");
  // Bundled interpreter → stdlib is a template-phase target.
  await mkdir(join(resources, "python", "Lib"), { recursive: true });
  await writeFile(join(resources, "python", "python.exe"), "", "utf8");
  // jw venv lives in the read-only payload → template phase too.
  const jwVenv = join(resources, "backend", ".sciencediscovery-data", "jiuwenswarm", "src", ".venv");
  await mkdir(join(jwVenv, "Scripts"), { recursive: true });
  await writeFile(join(jwVenv, "Scripts", "python.exe"), "", "utf8");
  const paths = packagedPaths(resources);
  const envsDir = join(root, "data", "envs");

  const before = precompileTargets(paths, envsDir);
  assert.deepEqual(before.map((x) => [x.label, x.phase]),
    [["python stdlib", "template"], ["jiuwenswarm venv", "template"]]);

  // The copied venvs appear as unpacked-phase targets once they exist.
  await mkdir(join(envsDir, "gateway", "Scripts"), { recursive: true });
  await writeFile(join(envsDir, "gateway", "Scripts", "python.exe"), "", "utf8");
  const after = precompileTargets(paths, envsDir);
  assert.deepEqual(after.map((x) => [x.label, x.phase]), [
    ["python stdlib", "template"],
    ["gateway venv", "unpacked"],
    ["jiuwenswarm venv", "template"],
  ]);
  assert.equal(after[1].target, join(envsDir, "gateway", "Lib", "site-packages"));
});

// --- F10.6d2: concurrent tree copy -----------------------------------------------

test("treeHasPycache detects a shipped __pycache__ and stays quiet on cache-less trees", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sd-pycache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const withCache = join(root, "with");
  await mkdir(join(withCache, "pkg", "__pycache__"), { recursive: true });
  await writeFile(join(withCache, "pkg", "__pycache__", "mod.cpython-312.pyc"), "", "utf8");
  await writeFile(join(withCache, "pkg", "mod.py"), "", "utf8");
  assert.equal(await treeHasPycache(withCache), true);

  const cacheLess = join(root, "without");
  await mkdir(join(cacheLess, "pkg"), { recursive: true });
  await writeFile(join(cacheLess, "pkg", "mod.py"), "", "utf8");
  assert.equal(await treeHasPycache(cacheLess), false);
  // Empty __pycache__ (no .pyc inside) does not count.
  await mkdir(join(cacheLess, "pkg", "__pycache__"), { recursive: true });
  assert.equal(await treeHasPycache(cacheLess), false);
  assert.equal(await treeHasPycache(join(root, "missing")), false);
});

test("copyTreeConcurrent copies a nested tree and reports monotonic progress", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sd-f10copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, "src");
  await mkdir(join(src, "a", "b"), { recursive: true });
  await mkdir(join(src, "empty"), { recursive: true });
  await writeFile(join(src, "top.txt"), "top", "utf8");
  await writeFile(join(src, "a", "mid.txt"), "mid", "utf8");
  await writeFile(join(src, "a", "b", "deep.txt"), "deep", "utf8");

  const dest = join(root, "dest");
  const reports: Array<[number, number]> = [];
  await copyTreeConcurrent(src, dest, { concurrency: 2, onProgress: (done, total) => reports.push([done, total]) });

  assert.equal(await readFile(join(dest, "top.txt"), "utf8"), "top");
  assert.equal(await readFile(join(dest, "a", "mid.txt"), "utf8"), "mid");
  assert.equal(await readFile(join(dest, "a", "b", "deep.txt"), "utf8"), "deep");
  assert.ok(existsSync(join(dest, "empty"))); // empty dirs survive
  // 3 files copied, every report well-formed and monotonic.
  assert.equal(reports.length, 3);
  for (const [i, [done, total]] of reports.entries()) {
    assert.equal(total, 3);
    assert.equal(done, i + 1);
  }
});

test("copyTreeConcurrent into a partially-populated destination overwrites cleanly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sd-f10copy2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, "src");
  await mkdir(join(src, "a"), { recursive: true });
  await writeFile(join(src, "a", "x.txt"), "new", "utf8");
  const dest = join(root, "dest");
  await mkdir(join(dest, "a"), { recursive: true });
  await writeFile(join(dest, "a", "x.txt"), "stale", "utf8");
  await copyTreeConcurrent(src, dest);
  assert.equal(await readFile(join(dest, "a", "x.txt"), "utf8"), "new");
});

test("bootstrapPackaged unpacks once, rewrites venv homes, and re-runs after a reinstall elsewhere", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sd-f10-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, "resources");
  const template = join(resources, "envs-template");
  await mkdir(join(template, "gateway"), { recursive: true });
  await mkdir(join(template, "evolve"), { recursive: true });
  await writeFile(join(template, "gateway", "pyvenv.cfg"), "home = C:\\builder\\python\n", "utf8");
  // Editable .pth with the assemble-time backend placeholder.
  const gatewaySp = join(template, "gateway", "Lib", "site-packages");
  await mkdir(gatewaySp, { recursive: true });
  await writeFile(join(gatewaySp, "_editable_impl_sciencediscovery_gateway.pth"),
    "@@SD_BACKEND_ROOT@@\\services\\gateway\\src\n", "utf8");
  // The other template venvs can be empty dirs here; fixVenvHome warns and skips.
  const jwVenv = join(resources, "backend", ".sciencediscovery-data", "jiuwenswarm", "src", ".venv");
  await mkdir(jwVenv, { recursive: true });
  await writeFile(join(jwVenv, "pyvenv.cfg"), "home = C:\\builder\\python\n", "utf8");

  const dataDir = join(root, "data");
  const paths = packagedPaths(resources);
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  const first = await bootstrapPackaged(paths, dataDir, log);
  assert.equal(first.unpacked, true);
  // F10.6d: fixture venvs carry no Scripts/python.exe → precompile skips cleanly.
  assert.equal(first.precompiled, 0);
  assert.equal((await readFile(join(dataDir, "envs", "gateway", "pyvenv.cfg"), "utf8")).trim(),
    `home = ${join(resources, "python")}`);
  assert.equal(
    (await readFile(join(dataDir, "envs", "gateway", "Lib", "site-packages", "_editable_impl_sciencediscovery_gateway.pth"), "utf8")).trim(),
    join(resources, "backend", "services", "gateway", "src"));
  assert.equal((await readFile(join(jwVenv, "pyvenv.cfg"), "utf8")).trim(),
    `home = ${join(resources, "python")}`);

  // Second run on the same install: stamp valid → no-op.
  const second = await bootstrapPackaged(paths, dataDir, log);
  assert.equal(second.unpacked, false);

  // F10.6n: a same-location reinstall re-ships the payload's in-place jw venv
  // with the builder's home; the stamp-valid no-op path must repair it too.
  await writeFile(join(jwVenv, "pyvenv.cfg"), "home = C:\\builder\\python\n", "utf8");
  const repaired = await bootstrapPackaged(paths, dataDir, log);
  assert.equal(repaired.unpacked, false);
  assert.equal((await readFile(join(jwVenv, "pyvenv.cfg"), "utf8")).trim(),
    `home = ${join(resources, "python")}`);

  // Reinstall to a different directory: stamp mismatch → re-unpack.
  const movedResources = join(root, "resources2");
  await mkdir(join(movedResources, "envs-template", "gateway"), { recursive: true });
  await writeFile(join(movedResources, "envs-template", "gateway", "pyvenv.cfg"), "home = C:\\builder\\python\n", "utf8");
  const third = await bootstrapPackaged(packagedPaths(movedResources), dataDir, log);
  assert.equal(third.unpacked, true);
  assert.equal((await readFile(join(dataDir, "envs", "gateway", "pyvenv.cfg"), "utf8")).trim(),
    `home = ${join(movedResources, "python")}`);

  // needsUnpack mirrors the same decision.
  assert.equal(needsUnpack(dataDir, movedResources), false);
  assert.equal(needsUnpack(dataDir, join(root, "elsewhere")), true);
  assert.ok(stampPath(dataDir).endsWith(join("envs", ".shell-unpacked")));
});
