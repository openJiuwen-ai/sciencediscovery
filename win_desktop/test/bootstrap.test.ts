// Packaged bootstrap: pure-decision tests. The IO path (bootstrapPackaged)
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
  // SIZEOPT W2: one shared venv for all five Python sidecars; the independent
  // Idea Tree service is its own uv project with its own venv.
  assert.ok(p.venvNames.includes("sd-services"));
  assert.ok(p.venvNames.includes("idea-tree"));
  // SIZEOPT W6 / design D11: short payload layout backend\jw (was
  // backend\.sciencediscovery-data\jiuwenswarm\src) to reclaim MAX_PATH budget.
  assert.equal(p.jwSrc, join("C:\\Program Files\\SD\\resources", "backend", "jw"));
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
  assert.equal(env.JIUWENSWARM_SRC, join("C:\\res", "backend", "jw"));
  assert.equal(env.SCIENCE_AGENT_PAPER_PYTHON_PATH, join("D:\\data", "envs", "sd-services", "Scripts", "python.exe"));
  // The API always dials Idea Tree, so the packaged shell must hand the stack
  // its interpreter explicitly (no evolve fallback exists any more).
  assert.equal(env.SCIENCE_AGENT_IDEA_TREE_PYTHON_PATH, join("D:\\data", "envs", "idea-tree", "Scripts", "python.exe"));
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

test("compileallArgs pins the quiet content-hash compileall invocation for a target", () => {
  const target = join("D:", "data", "envs", "gateway", "Lib", "site-packages");
  assert.deepEqual(compileallArgs(target),
    ["-m", "compileall", "-q", "--invalidation-mode", "checked-hash", target]);
});

// --- Precompile targets split by phase ----------------------------------

test("precompileTargets: before unpack only template-phase targets exist; after it the venvs appear", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sd-shell-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, "resources");
  // Bundled interpreter → stdlib is a template-phase target.
  await mkdir(join(resources, "python", "Lib"), { recursive: true });
  await writeFile(join(resources, "python", "python.exe"), "", "utf8");
  // jw venv lives in the read-only payload → template phase too.
  const jwVenv = join(resources, "backend", "jw", ".venv");
  await mkdir(join(jwVenv, "Scripts"), { recursive: true });
  await writeFile(join(jwVenv, "Scripts", "python.exe"), "", "utf8");
  const paths = packagedPaths(resources);
  const envsDir = join(root, "data", "envs");

  const before = precompileTargets(paths, envsDir);
  assert.deepEqual(before.map((x) => [x.label, x.phase]),
    [["python stdlib", "template"], ["jiuwenswarm venv", "template"]]);

  // The copied shared venv appears as an unpacked-phase target once it exists.
  await mkdir(join(envsDir, "sd-services", "Scripts"), { recursive: true });
  await writeFile(join(envsDir, "sd-services", "Scripts", "python.exe"), "", "utf8");
  const after = precompileTargets(paths, envsDir);
  assert.deepEqual(after.map((x) => [x.label, x.phase]), [
    ["python stdlib", "template"],
    ["sd-services venv", "unpacked"],
    ["jiuwenswarm venv", "template"],
  ]);
  assert.equal(after[1].target, join(envsDir, "sd-services", "Lib", "site-packages"));
});

// --- Concurrent tree copy -----------------------------------------------

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
  const root = await mkdtemp(join(tmpdir(), "sd-shell-copy-"));
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
  const root = await mkdtemp(join(tmpdir(), "sd-shell-copy2-"));
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
  const root = await mkdtemp(join(tmpdir(), "sd-shell-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, "resources");
  const template = join(resources, "envs-template");
  // SIZEOPT W2: the payload stages one shared venv (the five sidecars' union).
  await mkdir(join(template, "sd-services"), { recursive: true });
  await writeFile(join(template, "sd-services", "pyvenv.cfg"), "home = C:\\builder\\python\n", "utf8");
  // Editable .pth with the assemble-time backend placeholder (the shared venv
  // carries one such file per editable sidecar).
  const sharedSp = join(template, "sd-services", "Lib", "site-packages");
  await mkdir(sharedSp, { recursive: true });
  await writeFile(join(sharedSp, "_editable_impl_sciencediscovery_gateway.pth"),
    "@@SD_BACKEND_ROOT@@\\services\\gateway\\src\n", "utf8");
  const jwVenv = join(resources, "backend", "jw", ".venv");
  await mkdir(jwVenv, { recursive: true });
  await writeFile(join(jwVenv, "pyvenv.cfg"), "home = C:\\builder\\python\n", "utf8");

  const dataDir = join(root, "data");
  const paths = packagedPaths(resources);
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  const first = await bootstrapPackaged(paths, dataDir, log);
  assert.equal(first.unpacked, true);
  // Fixture venvs carry no Scripts/python.exe → precompile skips cleanly.
  assert.equal(first.precompiled, 0);
  assert.equal((await readFile(join(dataDir, "envs", "sd-services", "pyvenv.cfg"), "utf8")).trim(),
    `home = ${join(resources, "python")}`);
  assert.equal(
    (await readFile(join(dataDir, "envs", "sd-services", "Lib", "site-packages", "_editable_impl_sciencediscovery_gateway.pth"), "utf8")).trim(),
    join(resources, "backend", "services", "gateway", "src"));
  assert.equal((await readFile(join(jwVenv, "pyvenv.cfg"), "utf8")).trim(),
    `home = ${join(resources, "python")}`);

  // Second run on the same install: stamp valid → no-op.
  const second = await bootstrapPackaged(paths, dataDir, log);
  assert.equal(second.unpacked, false);

  // A same-location reinstall re-ships the payload's in-place jw venv
  // with the builder's home; the stamp-valid no-op path must repair it too.
  await writeFile(join(jwVenv, "pyvenv.cfg"), "home = C:\\builder\\python\n", "utf8");
  const repaired = await bootstrapPackaged(paths, dataDir, log);
  assert.equal(repaired.unpacked, false);
  assert.equal((await readFile(join(jwVenv, "pyvenv.cfg"), "utf8")).trim(),
    `home = ${join(resources, "python")}`);

  // Reinstall to a different directory: stamp mismatch → re-unpack.
  const movedResources = join(root, "resources2");
  await mkdir(join(movedResources, "envs-template", "sd-services"), { recursive: true });
  await writeFile(join(movedResources, "envs-template", "sd-services", "pyvenv.cfg"), "home = C:\\builder\\python\n", "utf8");
  const third = await bootstrapPackaged(packagedPaths(movedResources), dataDir, log);
  assert.equal(third.unpacked, true);
  assert.equal((await readFile(join(dataDir, "envs", "sd-services", "pyvenv.cfg"), "utf8")).trim(),
    `home = ${join(movedResources, "python")}`);

  // needsUnpack mirrors the same decision.
  assert.equal(needsUnpack(dataDir, movedResources), false);
  assert.equal(needsUnpack(dataDir, join(root, "elsewhere")), true);
  assert.ok(stampPath(dataDir).endsWith(join("envs", ".shell-unpacked")));
});

test("bootstrapPackaged in-place mode skips copy and fixes bundled venvs directly", async (t) => {
  const original = process.env.SCIENCE_AGENT_IN_PLACE_ENVS;
  process.env.SCIENCE_AGENT_IN_PLACE_ENVS = "1";
  t.after(() => {
    if (original === undefined) {
      delete process.env.SCIENCE_AGENT_IN_PLACE_ENVS;
    } else {
      process.env.SCIENCE_AGENT_IN_PLACE_ENVS = original;
    }
  });

  const root = await mkdtemp(join(tmpdir(), "sd-shell-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, "resources");
  const template = join(resources, "envs-template");
  await mkdir(join(template, "sd-services"), { recursive: true });
  await writeFile(join(template, "sd-services", "pyvenv.cfg"), "home = C:\\builder\\python\n", "utf8");
  const sharedSp = join(template, "sd-services", "Lib", "site-packages");
  await mkdir(sharedSp, { recursive: true });
  await writeFile(join(sharedSp, "_editable_impl_sciencediscovery_gateway.pth"),
    "@@SD_BACKEND_ROOT@@\\services\\gateway\\src\n", "utf8");
  const jwVenv = join(resources, "backend", "jw", ".venv");
  await mkdir(jwVenv, { recursive: true });
  await writeFile(join(jwVenv, "pyvenv.cfg"), "home = C:\\builder\\python\n", "utf8");

  const dataDir = join(root, "data");
  const paths = packagedPaths(resources);
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  const result = await bootstrapPackaged(paths, dataDir, log);
  assert.equal(result.unpacked, true);
  assert.equal(result.jwFixed, true);
  // In-place mode must not copy venvs into the data directory.
  assert.equal(existsSync(join(dataDir, "envs", "sd-services")), false);
  // The template venv should be fixed in place.
  assert.equal((await readFile(join(template, "sd-services", "pyvenv.cfg"), "utf8")).trim(),
    `home = ${join(resources, "python")}`);
  assert.equal(
    (await readFile(join(template, "sd-services", "Lib", "site-packages", "_editable_impl_sciencediscovery_gateway.pth"), "utf8")).trim(),
    join(resources, "backend", "services", "gateway", "src"));
  // A stamp should still be written to the data dir for diagnostics.
  assert.equal(existsSync(stampPath(dataDir)), true);
  // It should report the in-place fix in timing logs.
  assert.ok(lines.some((l) => l.includes("[perf] in-place venv fix elapsed=")));
});

test("packagedEnv uses in-place venv paths when SCIENCE_AGENT_IN_PLACE_ENVS=1", async (t) => {
  const original = process.env.SCIENCE_AGENT_IN_PLACE_ENVS;
  process.env.SCIENCE_AGENT_IN_PLACE_ENVS = "1";
  t.after(() => {
    if (original === undefined) {
      delete process.env.SCIENCE_AGENT_IN_PLACE_ENVS;
    } else {
      process.env.SCIENCE_AGENT_IN_PLACE_ENVS = original;
    }
  });

  const root = await mkdtemp(join(tmpdir(), "sd-shell-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = packagedPaths(join(root, "resources"));
  const env = packagedEnv(paths, join(root, "data"));
  assert.equal(env.SCIENCE_AGENT_ENVS_DIR, join(root, "resources", "envs-template"));
  assert.equal(env.SCIENCE_AGENT_PAPER_PYTHON_PATH, join(root, "resources", "envs-template", "sd-services", "Scripts", "python.exe"));
});
