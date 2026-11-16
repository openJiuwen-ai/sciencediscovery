// Packaged bootstrap: pure-decision tests. The IO path (bootstrapPackaged)
// copies trees and rewrites pyvenv.cfg lines — its building blocks are the
// functions under test here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep, dirname } from "node:path";

import {
  bootstrapPackaged, compileallArgs, copyTreeConcurrent, countBytecode, dirWritable, needsUnpack, packagedEnv, packagedPaths,
  precompileTargets, readPayloadBytecodeManifest, rewriteEditablePth, rewritePyvenvHome, stampPath, treeHasPycache,
} from "../src/bootstrap.ts";
import { resolveRepoRoot } from "../src/config.ts";
import { pythonMinorFromPyvenvCfg, venvLayoutFor } from "../src/shell-platform.ts";

// Platform-aware fixtures: the tests below exercise the CURRENT host's
// payload layout, so they are meaningful on both win32 (Windows dev/test
// machines) and darwin (Mac dev machines). Cross-platform branch coverage
// (the darwin path families on a win32 host and vice versa) is injected
// explicitly via the platform parameter.
const IS_DARWIN = process.platform === "darwin";
const SEP = sep; // host separator — fixtures build paths that match the code's output on THIS machine

// --- resolveRepoRoot: packaged vs dev ----------------------------------------

test("resolveRepoRoot prefers env, then packaged layout, then dev sibling", () => {
  assert.equal(resolveRepoRoot({ SD_SHELL_REPO: "E:\\custom" }, "C:\\shell"), "E:\\custom");
  assert.equal(resolveRepoRoot({ SD_SHELL_REPO: "E:\\custom" }, "C:\\shell", "C:\\res"), "E:\\custom");
  assert.equal(resolveRepoRoot({}, "C:\\shell", "C:\\res"), join("C:\\res", "backend"));
  assert.equal(resolveRepoRoot({}, "C:\\shell", null), join("C:\\shell", "..", "sciencediscovery"));
  assert.equal(resolveRepoRoot({}, "C:\\shell"), join("C:\\shell", "..", "sciencediscovery"));
});

// --- packagedPaths ------------------------------------------------------------

test("packagedPaths maps the installer layout (win32)", () => {
  const p = packagedPaths("C:\\Program Files\\SD\\resources", "win32");
  assert.equal(p.backend, join("C:\\Program Files\\SD\\resources", "backend"));
  assert.equal(p.python, join("C:\\Program Files\\SD\\resources", "python"));
  assert.equal(p.micromamba, join("C:\\Program Files\\SD\\resources", "micromamba", "micromamba.exe"));
  assert.equal(p.envsTemplate, join("C:\\Program Files\\SD\\resources", "envs-template"));
  // SIZEOPT W2: one shared venv for all five Python sidecars.
  assert.ok(p.venvNames.includes("sd-services"));
  // SIZEOPT W6 / design D11: short payload layout backend\jw (was
  // backend\.sciencediscovery-data\jiuwenswarm\src) to reclaim MAX_PATH budget.
  assert.equal(p.jwSrc, join("C:\\Program Files\\SD\\resources", "backend", "jw"));
});

test("packagedPaths maps the darwin payload layout (no .exe suffixes)", () => {
  const p = packagedPaths("/Applications/ScienceDiscovery.app/Contents/Resources", "darwin");
  assert.equal(p.micromamba, join("/Applications/ScienceDiscovery.app/Contents/Resources", "micromamba", "micromamba"));
  assert.ok(!p.micromamba.endsWith(".exe"), "darwin micromamba has no suffix");
  // The rest of the layout (backend/python/envs-template/jw) is identical.
  assert.equal(p.backend, join("/Applications/ScienceDiscovery.app/Contents/Resources", "backend"));
  assert.equal(p.jwSrc, join("/Applications/ScienceDiscovery.app/Contents/Resources", "backend", "jw"));
});

// --- packagedEnv ---------------------------------------------------------------

test("packagedEnv injects the packaged-mode contract (win32)", () => {
  const p = packagedPaths("C:\\res", "win32");
  const env = packagedEnv(p, "D:\\data", "win32");
  assert.equal(env.SCIENCE_AGENT_PACKAGED, "1");
  assert.equal(env.SCIENCE_AGENT_PYTHON_PATH, join("C:\\res", "python", "python.exe"));
  assert.equal(env.SCIENCE_AGENT_PROVISIONER_PATH, join("C:\\res", "micromamba", "micromamba.exe"));
  // No PYTHONPYCACHEPREFIX: the payload's in-place __pycache__ must be used.
  assert.equal(env.PYTHONPYCACHEPREFIX, undefined);
  assert.equal(env.JIUWENSWARM_ROOT, join("D:\\data", "jiuwenswarm"));
  // W1/P2 fix: the jw workspace HOME-class anchor must be data-dir-based, so
  // .jiuwenswarm-instances never lands in the real %USERPROFILE%.
  assert.equal(env.JIUWENSWARM_HOME, join("D:\\data", "jiuwenswarm-home"));
  assert.equal(env.JIUWENSWARM_SRC, join("C:\\res", "backend", "jw"));
  assert.equal(env.SCIENCE_AGENT_PAPER_PYTHON_PATH, join("D:\\data", "envs", "sd-services", "Scripts", "python.exe"));
  // The Windows-only unisolated opt-in (Seatbelt exists nowhere on win32).
  assert.equal(env.SCIENCE_AGENT_EVOLVE_UNISOLATED, "1");
});

test("packagedEnv: darwin uses POSIX venv paths and NEVER opts into unisolated", () => {
  const p = packagedPaths("/res", "darwin");
  const env = packagedEnv(p, "/data", "darwin");
  // The darwin payload bundles the uv python INSTALL ROOT, so the bundled
  // interpreter keeps its bin/ layout (<out>/python/bin/python3) — unlike
  // win32 where python.exe sits at the payload-python root.
  assert.equal(env.SCIENCE_AGENT_PYTHON_PATH, join("/res", "python", "bin", "python3"));
  assert.equal(env.SCIENCE_AGENT_PROVISIONER_PATH, join("/res", "micromamba", "micromamba"));
  assert.equal(env.SCIENCE_AGENT_PAPER_PYTHON_PATH, join("/data", "envs", "sd-services", "bin", "python3"));
  // Same W1 fix on darwin: never fall back to process.env.HOME (~ on macOS).
  assert.equal(env.JIUWENSWARM_HOME, join("/data", "jiuwenswarm-home"));
  // Seatbelt answers on darwin without any opt-in; the unisolated escape
  // hatch stays a Windows-only contract (defense in depth even though the
  // api's darwin branch ignores the flag today).
  assert.equal(env.SCIENCE_AGENT_EVOLVE_UNISOLATED, undefined);
  // [mac-desktop] W22: the jw venv runs straight out of the sealed bundle —
  // Python must never write bytecode there or the codesign seal breaks.
  assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
  // ...and win32 keeps its historical env (no seal to protect).
  const w = packagedEnv(packagedPaths("/res", "win32"), "/data", "win32");
  assert.equal(w.PYTHONDONTWRITEBYTECODE, undefined);
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
  const layout = venvLayoutFor(IS_DARWIN ? "darwin" : "win32");
  // Bundled interpreter → stdlib is a template-phase target. The interpreter
  // file path (darwin: python/bin/python3 — install-root layout; win32:
  // python/python.exe — root-level exe) may nest, so mkdir its dirname.
  const bundledPython = join(resources, "python", layout.basePython);
  await mkdir(dirname(bundledPython), { recursive: true });
  await mkdir(join(resources, "python", IS_DARWIN ? "lib/python3.12" : "Lib"), { recursive: true });
  await writeFile(bundledPython, "", "utf8");
  // jw venv lives in the read-only payload → template phase too.
  const jwVenv = join(resources, "backend", "jw", ".venv");
  await mkdir(join(jwVenv, layout.venvBin), { recursive: true });
  await writeFile(join(jwVenv, layout.venvBin, layout.venvPython), "", "utf8");
  await writeFile(join(jwVenv, "pyvenv.cfg"), "home = /builder/python\nversion_info = 3.12.7\n", "utf8");
  const paths = packagedPaths(resources);
  const envsDir = join(root, "data", "envs");

  const before = precompileTargets(paths, envsDir);
  assert.deepEqual(before.map((x) => [x.label, x.phase]),
    [["python stdlib", "template"], ["jiuwenswarm venv", "template"]]);

  // The copied shared venv appears as an unpacked-phase target once it exists.
  await mkdir(join(envsDir, "sd-services", layout.venvBin), { recursive: true });
  await writeFile(join(envsDir, "sd-services", layout.venvBin, layout.venvPython), "", "utf8");
  await writeFile(join(envsDir, "sd-services", "pyvenv.cfg"), "home = /builder/python\nversion_info = 3.12.7\n", "utf8");
  const after = precompileTargets(paths, envsDir);
  assert.deepEqual(after.map((x) => [x.label, x.phase]), [
    ["python stdlib", "template"],
    ["sd-services venv", "unpacked"],
    ["jiuwenswarm venv", "template"],
  ]);
  // site-packages follows the DIALECT under test (win32: Lib\site-packages;
  // darwin: lib/python3.12/site-packages, minor read from pyvenv.cfg above).
  // Derived with the same layout expression the code uses, so the assertion
  // mirrors the dialect's real shape on ANY host (review F4: on Linux the
  // old host-conditional form expected a host-separator path the win32
  // dialect never produces).
  const expectedSp = join(envsDir, "sd-services", ...layout.sitePackages("12").split("/"));
  assert.equal(after[1].target, expectedSp);
  // On darwin the minor must come from the venv's own pyvenv.cfg, never a
  // hardcode: a 3.13 venv must land its site-packages under python3.13.
  if (IS_DARWIN) {
    await writeFile(join(envsDir, "sd-services", "pyvenv.cfg"), "home = /builder/python\nversion_info = 3.13.1\n", "utf8");
    const bumped = precompileTargets(paths, envsDir);
    assert.equal(bumped[1].target, join(envsDir, "sd-services", "lib", "python3.13", "site-packages"));
  }
});

test("precompileTargets (darwin fixture): minor comes from pyvenv.cfg, stdlib from lib/ dir listing", async (t) => {
  // Cross-platform branch coverage: the darwin path family exercised with an
  // explicit platform injection, meaningful on any host.
  const root = await mkdtemp(join(tmpdir(), "sd-shell-env-darwin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, "resources");
  // darwin base interpreter: install-root layout — bin/python3 +
  // lib/python3.13/ stdlib (bundledBasePythonPath nests one level).
  await mkdir(join(resources, "python", "lib", "python3.13"), { recursive: true });
  await mkdir(join(resources, "python", "bin"), { recursive: true });
  await writeFile(join(resources, "python", "bin", "python3"), "", "utf8");
  const paths = packagedPaths(resources, "darwin");
  const envsDir = join(root, "data", "envs");

  await mkdir(join(envsDir, "sd-services", "bin"), { recursive: true });
  await writeFile(join(envsDir, "sd-services", "bin", "python3"), "", "utf8");
  await writeFile(join(envsDir, "sd-services", "pyvenv.cfg"), "version_info = 3.13.5\n", "utf8");
  const targets = precompileTargets(paths, envsDir, "darwin");
  assert.deepEqual(targets.map((x) => x.label), ["python stdlib", "sd-services venv"]);
  assert.equal(targets[0].target, join(resources, "python", "lib", "python3.13"), "stdlib minor discovered by listing lib/");
  assert.equal(targets[1].target, join(envsDir, "sd-services", "lib", "python3.13", "site-packages"));
  assert.equal(targets[1].python, join(envsDir, "sd-services", "bin", "python3"));

  // A venv whose pyvenv.cfg is unreadable is skipped, not guessed.
  await rm(join(envsDir, "sd-services", "pyvenv.cfg"), { force: true });
  const degraded = precompileTargets(paths, envsDir, "darwin");
  assert.deepEqual(degraded.map((x) => x.label), ["python stdlib"]);
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
  // Review F4: the fixture follows the DIALECT under test ("win32" is pinned
  // below), not the host. The shared venv's site-packages and the .pth body
  // are built with the win32 layout's own expressions, so the test passes on
  // any host (Linux CI included) by resolving exactly what a real Windows
  // boot resolves — the old host-conditional fixture only worked by the
  // accident of Windows' case-insensitive fs.
  const layout = venvLayoutFor("win32");
  // The .pth body keeps the platform's own separator: win32 assemble writes
  // @@SD_BACKEND_ROOT@@\...
  const pthSep = "\\";
  // SIZEOPT W2: the payload stages one shared venv (the five sidecars' union).
  await mkdir(join(template, "sd-services"), { recursive: true });
  await writeFile(join(template, "sd-services", "pyvenv.cfg"), "home = /builder/python\nversion_info = 3.12.7\n", "utf8");
  // Editable .pth with the assemble-time backend placeholder (the shared venv
  // carries one such file per editable sidecar).
  const sharedSp = join(template, "sd-services", ...layout.sitePackages("12").split("/"));
  await mkdir(sharedSp, { recursive: true });
  await writeFile(join(sharedSp, "_editable_impl_sciencediscovery_gateway.pth"),
    `@@SD_BACKEND_ROOT@@${pthSep}services${pthSep}gateway${pthSep}src\n`, "utf8");
  const jwVenv = join(resources, "backend", "jw", ".venv");
  await mkdir(jwVenv, { recursive: true });
  await writeFile(join(jwVenv, "pyvenv.cfg"), "home = /builder/python\nversion_info = 3.12.7\n", "utf8");

  const dataDir = join(root, "data");
  const paths = packagedPaths(resources);
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  // W22: the jw in-bundle home rewrite is a win32-only behaviour now —
  // darwin must never write inside the sealed .app bundle. Pin the win32
  // platform so this test exercises that semantic wherever it runs.
  const first = await bootstrapPackaged(paths, dataDir, log, "win32");
  assert.equal(first.unpacked, true);
  // Fixture venvs carry no bin|Scripts python → precompile skips cleanly.
  assert.equal(first.precompiled, 0);
  // Only the home LINE is rewritten; version_info etc. must survive.
  const homeLine = (await readFile(join(dataDir, "envs", "sd-services", "pyvenv.cfg"), "utf8"))
    .match(/^home\s*=.*$/m)?.[0]?.trim();
  assert.equal(homeLine, `home = ${join(resources, "python")}`);
  assert.equal(
    (await readFile(join(dataDir, "envs", "sd-services", ...layout.sitePackages("12").split("/"), "_editable_impl_sciencediscovery_gateway.pth"), "utf8")).trim(),
    // rewriteEditablePth replaces ONLY the placeholder: the backend root is
    // host-joined, everything after it survives byte-for-byte. On a Windows
    // host both halves are backslashes; on any host this pins the replacement
    // semantics (dialect pth body + host backend root) exactly as the code does.
    `${join(resources, "backend")}${pthSep}services${pthSep}gateway${pthSep}src`);
  const jwHome = (await readFile(join(jwVenv, "pyvenv.cfg"), "utf8")).match(/^home\s*=.*$/m)?.[0]?.trim();
  assert.equal(jwHome, `home = ${join(resources, "python")}`);

  // Second run on the same install: stamp valid → no-op.
  const second = await bootstrapPackaged(paths, dataDir, log, "win32");
  assert.equal(second.unpacked, false);

  // A same-location reinstall re-ships the payload's in-place jw venv
  // with the builder's home; the stamp-valid no-op path must repair it too.
  await writeFile(join(jwVenv, "pyvenv.cfg"), "home = /builder/python\n", "utf8");
  const repaired = await bootstrapPackaged(paths, dataDir, log, "win32");
  assert.equal(repaired.unpacked, false);
  const repairedHome = (await readFile(join(jwVenv, "pyvenv.cfg"), "utf8")).match(/^home\s*=.*$/m)?.[0]?.trim();
  assert.equal(repairedHome, `home = ${join(resources, "python")}`);

  // Reinstall to a different directory: stamp mismatch → re-unpack.
  const movedResources = join(root, "resources2");
  await mkdir(join(movedResources, "envs-template", "sd-services"), { recursive: true });
  await writeFile(join(movedResources, "envs-template", "sd-services", "pyvenv.cfg"), "home = /builder/python\n", "utf8");
  const third = await bootstrapPackaged(packagedPaths(movedResources), dataDir, log, "win32");
  assert.equal(third.unpacked, true);
  const thirdHome = (await readFile(join(dataDir, "envs", "sd-services", "pyvenv.cfg"), "utf8")).match(/^home\s*=.*$/m)?.[0]?.trim();
  assert.equal(thirdHome, `home = ${join(movedResources, "python")}`);

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
  // Review F4: dialect follows the pinned "win32" below, not the host —
  // fixture paths derive from the win32 layout's own expressions so the
  // in-place branch resolves identically on any host.
  const layout = venvLayoutFor("win32");
  const pthSep = "\\";
  await mkdir(join(template, "sd-services"), { recursive: true });
  await writeFile(join(template, "sd-services", "pyvenv.cfg"), "home = /builder/python\nversion_info = 3.12.7\n", "utf8");
  const sharedSp = join(template, "sd-services", ...layout.sitePackages("12").split("/"));
  await mkdir(sharedSp, { recursive: true });
  await writeFile(join(sharedSp, "_editable_impl_sciencediscovery_gateway.pth"),
    `@@SD_BACKEND_ROOT@@${pthSep}services${pthSep}gateway${pthSep}src\n`, "utf8");
  const jwVenv = join(resources, "backend", "jw", ".venv");
  await mkdir(jwVenv, { recursive: true });
  await writeFile(join(jwVenv, "pyvenv.cfg"), "home = /builder/python\nversion_info = 3.12.7\n", "utf8");

  const dataDir = join(root, "data");
  const paths = packagedPaths(resources);
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  // W22: in-place is the win32 packaged default; darwin always falls back to
  // the copy mode (sealed bundle). Pin win32 to exercise the in-place branch.
  const result = await bootstrapPackaged(paths, dataDir, log, "win32");
  assert.equal(result.unpacked, true);
  assert.equal(result.jwFixed, true);
  // In-place mode must not copy venvs into the data directory.
  assert.equal(existsSync(join(dataDir, "envs", "sd-services")), false);
  // The template venv should be fixed in place.
  const inplaceHome = (await readFile(join(template, "sd-services", "pyvenv.cfg"), "utf8")).match(/^home\s*=.*$/m)?.[0]?.trim();
  assert.equal(inplaceHome, `home = ${join(resources, "python")}`);
  assert.equal(
    (await readFile(join(template, "sd-services", ...layout.sitePackages("12").split("/"), "_editable_impl_sciencediscovery_gateway.pth"), "utf8")).trim(),
    // Same replacement-semantics pin as the unpack test above: backend root
    // host-joined + dialect pth body, byte-for-byte what rewriteEditablePth
    // leaves behind on any host.
    `${join(resources, "backend")}${pthSep}services${pthSep}gateway${pthSep}src`);
  // A stamp should still be written to the data dir for diagnostics.
  assert.equal(existsSync(stampPath(dataDir)), true);
  // It should report the in-place fix in timing logs.
  assert.ok(lines.some((l) => l.includes("[perf] in-place venv fix elapsed=")));
});

// --- W16: read-only payload (running off a mounted DMG) -----------------------

test("dirWritable answers true for a writable dir and false for a read-only one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sd-shell-writable-"));
  t.after(() => {
    // restore before rm so the cleanup itself can delete the tree
    chmod(join(root, "ro"), 0o755).catch(() => {});
    return rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "rw"), { recursive: true });
  await mkdir(join(root, "ro"), { recursive: true });
  // 0o555 = r-x: write() fails even for root's owner on POSIX — the probe
  // must catch EACCES/EROFS alike (the DMG case surfaces EROFS, this
  // fixture approximates with EACCES via mode bits; both are "cannot write").
  await chmod(join(root, "ro"), 0o555);
  assert.equal(await dirWritable(join(root, "rw")), true);
  assert.equal(await dirWritable(join(root, "ro")), false);
});

test("bootstrapPackaged degrades in-place to copy mode on a read-only payload (W16 DMG run)", async (t) => {
  const original = process.env.SCIENCE_AGENT_IN_PLACE_ENVS;
  process.env.SCIENCE_AGENT_IN_PLACE_ENVS = "1";
  t.after(() => {
    if (original === undefined) {
      delete process.env.SCIENCE_AGENT_IN_PLACE_ENVS;
    } else {
      process.env.SCIENCE_AGENT_IN_PLACE_ENVS = original;
    }
  });

  const root = await mkdtemp(join(tmpdir(), "sd-shell-bootstrap-ro-"));
  t.after(() => {
    chmod(join(root, "resources"), 0o755).catch(() => {});
    return rm(root, { recursive: true, force: true });
  });
  const resources = join(root, "resources");
  const template = join(resources, "envs-template");
  await mkdir(join(template, "sd-services"), { recursive: true });
  await writeFile(join(template, "sd-services", "pyvenv.cfg"), "home = /builder/python\nversion_info = 3.12.7\n", "utf8");
  const jwVenv = join(resources, "backend", "jw", ".venv");
  await mkdir(jwVenv, { recursive: true });
  await writeFile(join(jwVenv, "pyvenv.cfg"), "home = /builder/python\nversion_info = 3.12.7\n", "utf8");
  // read-only payload — what a DMG mount looks like to the shell
  await chmod(resources, 0o555);

  const dataDir = join(root, "data");
  const paths = packagedPaths(resources);
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  // W22: pin win32 — this test asserts the W16 READ-ONLY degradation path,
  // which on darwin now also has the W22 seal guard in front of it (a
  // different log line). The read-only path itself is platform-neutral,
  // but its in-place entry condition is win32-only now.
  const result = await bootstrapPackaged(paths, dataDir, log, "win32");
  // Degraded to copy mode: envs now land in the (writable) data dir...
  assert.equal(result.unpacked, true);
  assert.equal(existsSync(join(dataDir, "envs", "sd-services")), true);
  // ...the in-place fix never ran (no [perf] in-place line)...
  assert.equal(lines.some((l) => l.includes("in-place venv fix")), false);
  // ...and the fallback was announced.
  assert.ok(lines.some((l) => l.includes("read-only")));
  // The in-place env flag was cleared on the process so packagedEnv()
  // (which reads process.env) degrades in lockstep.
  assert.notEqual(process.env.SCIENCE_AGENT_IN_PLACE_ENVS, "1");
});

// --- W17: copied-out venvs need their python symlinks re-pointed ----------------
//
// The payload bakes venv bin/python* as relative hops for the venv's IN-PAYLOAD
// position (envs-template/<name> → ../../../python). The copy fallback moves a
// venv to <dataDir>/envs/<name>, where the same hop count resolves to thin air
// (measured live: <dataDir>/envs/sd-services/bin/python → /Users/<user>/python)
// and start-stack's venvPython() existsSync fail-fasts with "SHARED_ENV is
// missing". The darwin fixVenvLaunchers must re-point the links from the venv's
// CURRENT location. The test below is darwin-only (win32 venvs carry trampolines,
// not symlinks).

if (IS_DARWIN) {
  test("copied-out venv python symlinks re-point to the bundled interpreter (W17)", async (t) => {
    const original = process.env.SCIENCE_AGENT_IN_PLACE_ENVS;
    process.env.SCIENCE_AGENT_IN_PLACE_ENVS = "1";
    t.after(() => {
      if (original === undefined) {
        delete process.env.SCIENCE_AGENT_IN_PLACE_ENVS;
      } else {
        process.env.SCIENCE_AGENT_IN_PLACE_ENVS = original;
      }
    });

    const root = await mkdtemp(join(tmpdir(), "sd-shell-bootstrap-w17-"));
    t.after(() => {
      // restore before rm so the cleanup itself can delete the read-only tree
      chmod(join(root, "resources"), 0o755).catch(() => {});
      return rm(root, { recursive: true, force: true });
    });
    const resources = join(root, "resources");
    const template = join(resources, "envs-template");
    const bundledPython = join(resources, "python", "bin", "python3");

    // A payload-shaped template venv: pyvenv.cfg + bin/python* as the
    // in-payload relative hops the assemble script bakes (3 hops).
    const tmplVenv = join(template, "sd-services");
    await mkdir(join(tmplVenv, "bin"), { recursive: true });
    await writeFile(join(tmplVenv, "pyvenv.cfg"), `home = ${join(resources, "python")}\nversion_info = 3.12.7\n`, "utf8");
    // The bundled interpreter itself (a plain file stands in for the binary).
    await mkdir(dirname(bundledPython), { recursive: true });
    await writeFile(bundledPython, "#!/bin/sh\n", "utf8");
    for (const name of ["python", "python3", "python3.12"]) {
      await symlink("../../../python/bin/python3", join(tmplVenv, "bin", name));
    }

    // A data dir that is NOT a sibling of the app — the W17 scenario: the
    // copied venv's baked 3-hop link must NOT resolve from <dataDir>/envs.
    const dataDir = join(root, "elsewhere", "ScienceDiscovery");
    // read-only payload — the W16 DMG degradation that triggers the copy
    // fallback this test exercises.
    await chmod(resources, 0o555);
    const paths = packagedPaths(resources);
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    await bootstrapPackaged(paths, dataDir, log);

    const copiedVenv = join(dataDir, "envs", "sd-services");
    assert.equal(existsSync(copiedVenv), true, "copy fallback unpacked the venv");
    // THE W17 assertion: every copied venv python link must resolve to the
    // BUNDLED interpreter from the venv's actual location — this is exactly
    // what start-stack's venvPython()/existsSync gate checks before fail-fast.
    for (const name of ["python", "python3", "python3.12"]) {
      const link = join(copiedVenv, "bin", name);
      assert.equal(existsSync(link), true, `${name} must exist (start-stack's gate)`);
      assert.equal(realpathSync(link), realpathSync(bundledPython),
        `${name} must resolve to the bundled interpreter`);
    }
    assert.ok(lines.some((l) => l.includes("W17")),
      "the re-point was announced in the first-run log");
  });

  test("in-place venv symlinks are left alone (W17 idempotence / W22 seal guard)", async (t) => {
    // In-place mode the venv never moves, so the baked hop is CORRECT; the
    // fix must recognize an already-resolving link and not rewrite it (the
    // rewrite target for an in-place venv equals the baked link anyway, but
    // touching it would log noise and break the existsSync-in-place contract).
    // W22 on darwin: IN_PLACE=1 is degraded to copy mode by the seal guard,
    // so "left alone" is now DOUBLE-true — the template tree is never even
    // reached by the copy branch's launcher pass (that pass runs on the
    // copied tree under <dataDir>). This test pins both: the baked links
    // stay byte-identical AND the degradation was announced.
    const original = process.env.SCIENCE_AGENT_IN_PLACE_ENVS;
    process.env.SCIENCE_AGENT_IN_PLACE_ENVS = "1";
    t.after(() => {
      if (original === undefined) {
        delete process.env.SCIENCE_AGENT_IN_PLACE_ENVS;
      } else {
        process.env.SCIENCE_AGENT_IN_PLACE_ENVS = original;
      }
    });

    const root = await mkdtemp(join(tmpdir(), "sd-shell-bootstrap-w17-ip-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const resources = join(root, "resources");
    const template = join(resources, "envs-template");
    const bundledPython = join(resources, "python", "bin", "python3");

    const tmplVenv = join(template, "sd-services");
    await mkdir(join(tmplVenv, "bin"), { recursive: true });
    await writeFile(join(tmplVenv, "pyvenv.cfg"), `home = ${join(resources, "python")}\nversion_info = 3.12.7\n`, "utf8");
    await mkdir(dirname(bundledPython), { recursive: true });
    await writeFile(bundledPython, "#!/bin/sh\n", "utf8");
    const bakedTarget = "../../../python/bin/python3";
    for (const name of ["python", "python3", "python3.12"]) {
      await symlink(bakedTarget, join(tmplVenv, "bin", name));
    }

    const dataDir = join(root, "data");
    const paths = packagedPaths(resources);
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    await bootstrapPackaged(paths, dataDir, log);
    // W22 (darwin): the copy fallback ran, so the TEMPLATE tree must be
    // byte-identical — its baked links still resolve exactly as baked and
    // nothing was rewritten in place.
    for (const name of ["python", "python3", "python3.12"]) {
      const link = join(tmplVenv, "bin", name);
      assert.equal(realpathSync(link), realpathSync(bundledPython),
        `${name}: the in-bundle link must resolve as baked (payload untouched)`);
    }
    // The COPY under <dataDir>/envs got the W17 re-point (its baked hops are
    // dead from the data dir — that is the W17 scenario, still working).
    const copiedVenv = join(dataDir, "envs", "sd-services");
    assert.equal(existsSync(copiedVenv), true, "W22 degraded to copy mode");
    for (const name of ["python", "python3", "python3.12"]) {
      const link = join(copiedVenv, "bin", name);
      assert.equal(existsSync(link), true, `${name} must exist in the copy`);
      assert.equal(realpathSync(link), realpathSync(bundledPython),
        `${name}: the copied venv must be re-pointed (W17 still holds)`);
    }
    // W22: the seal guard fired and announced the copy fallback.
    assert.ok(lines.some((l) => l.includes("sealed")),
      "darwin must announce the seal-preserving copy fallback");
  });
}

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
  const layout = venvLayoutFor(IS_DARWIN ? "darwin" : "win32");
  const paths = packagedPaths(join(root, "resources"));
  const env = packagedEnv(paths, join(root, "data"));
  assert.equal(env.SCIENCE_AGENT_ENVS_DIR, join(root, "resources", "envs-template"));
  assert.equal(env.SCIENCE_AGENT_PAPER_PYTHON_PATH,
    join(root, "resources", "envs-template", "sd-services", layout.venvBin, layout.venvPython));
});

// --- countBytecode / readPayloadBytecodeManifest: the first-launch IO --------
//
// Pure-function coverage lives in pyc-budget.test.ts; these prove the two
// bootstrap.ts helpers actually walk a tree and read the manifest on disk,
// against real temp directories (same style as treeHasPycache above).

test("countBytecode walks every dir and separates .py from .pyc", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sd-count-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A nested layout: two modules with caches, one without, one unrelated file.
  await mkdir(join(root, "pkg", "__pycache__"), { recursive: true });
  await writeFile(join(root, "pkg", "a.py"), "", "utf8");
  await writeFile(join(root, "pkg", "__pycache__", "a.cpython-312.pyc"), "", "utf8");
  await mkdir(join(root, "sub", "deep", "__pycache__"), { recursive: true });
  await writeFile(join(root, "sub", "deep", "b.py"), "", "utf8");
  await writeFile(join(root, "sub", "deep", "__pycache__", "b.cpython-312.pyc"), "", "utf8");
  await writeFile(join(root, "sub", "c.py"), "", "utf8"); // no cache
  await writeFile(join(root, "sub", "notes.txt"), "", "utf8"); // ignored

  const counts = await countBytecode(root);
  assert.deepEqual(counts, { py: 3, pyc: 2 },
    "must count .py/.pyc at every depth and ignore everything else");
  // The whole point vs treeHasPycache: a partial tree is NOT "complete".
  assert.equal(await treeHasPycache(root), true,
    "treeHasPycache only sees that SOME .pyc exists — this is why it cannot gate");
});

test("countBytecode returns 0/0 for a missing tree instead of throwing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sd-count-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await countBytecode(join(root, "nope")), { py: 0, pyc: 0 },
    "an unreadable root counts nothing; first launch must not crash here");
});

test("readPayloadBytecodeManifest reads the envs-template region and tolerates absence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sd-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Missing file -> null (degrade to the absolute limit, never pass blind).
  assert.equal(readPayloadBytecodeManifest(root), null);

  await writeFile(join(root, "version.json"), JSON.stringify({
    bytecode: {
      py: 37998, pyc: 37324,
      byRegion: { "envs-template": { py: 6124, pyc: 6119 }, python: { py: 1095, pyc: 1094 } },
    },
  }), "utf8");
  assert.deepEqual(readPayloadBytecodeManifest(root), { py: 6124, pyc: 6119 },
    "must return the envs-template region bootstrap unpacks");

  // A manifest predating the bytecode field -> null, not a crash.
  await writeFile(join(root, "version.json"), JSON.stringify({ repoCommit: "x", piecesMB: {} }), "utf8");
  assert.equal(readPayloadBytecodeManifest(root), null);
  // Corrupt JSON -> null.
  await writeFile(join(root, "version.json"), "{ not json", "utf8");
  assert.equal(readPayloadBytecodeManifest(root), null);
});

// --- in-place mode: the packaged DEFAULT must be verified too ---------------
//
// SCIENCE_AGENT_IN_PLACE_ENVS=1 is what a packaged install actually runs with
// (main.ts sets it before calling bootstrapPackaged so first/cold start reaches
// the UI in ~10-20s). That branch runs its bytecode decision off
// treeHasPycache() and RETURNS before the copied-tree check below, so the
// release6 payload — 1,384 .pyc where the build compiled ~37,000 — looked fine
// on every real install. Wiring the check only into the copy branch left §2's
// promise unreachable on the default path (lesson L55: the code existing is not
// the code running).
//
// These drive bootstrapPackaged for real rather than asserting on source text,
// because a source-text guard is exactly what failed to catch that.

/** Build an envs-template payload fixture: `files` .py files, `caches` of them
 *  with a sibling .pyc, plus the venv scaffolding the fix passes touch. Returns
 *  the resources root. This is the SOURCE both branches run from — in-place uses
 *  it directly, copy mode unpacks it into <dataDir>\envs. No Scripts\python.exe,
 *  so precompileTargets() yields [] and no real compileall is spawned. */
async function makePayloadFixture(root: string, files: number, caches: number): Promise<string> {
  const resources = join(root, "resources");
  const sp = join(resources, "envs-template", "sd-services", "Lib", "site-packages", "pkg");
  await mkdir(join(sp, "__pycache__"), { recursive: true });
  await writeFile(join(resources, "envs-template", "sd-services", "pyvenv.cfg"), "home = C:\\builder\\python\n", "utf8");
  for (let i = 0; i < files; i += 1) {
    await writeFile(join(sp, `m${i}.py`), "", "utf8");
    if (i < caches) {
      await writeFile(join(sp, "__pycache__", `m${i}.cpython-312.pyc`), "", "utf8");
    }
  }
  return resources;
}

/** Write resources/version.json recording the envs-template region counts.
 *  `identity` supplies repoCommit + builtAt, the two fields payloadIdentity()
 *  keys on; omit it for a payload with no identity (payloadIdentity -> null). */
async function writeManifest(
  resources: string,
  region: { py: number; pyc: number },
  identity?: { repoCommit: string; builtAt: string },
): Promise<void> {
  await writeFile(join(resources, "version.json"), JSON.stringify({
    ...(identity ?? {}),
    bytecode: { py: region.py, pyc: region.pyc, byRegion: { "envs-template": region } },
  }), "utf8");
}

function withInPlaceEnvs(t: { after: (fn: () => void) => void }): void {
  const original = process.env.SCIENCE_AGENT_IN_PLACE_ENVS;
  process.env.SCIENCE_AGENT_IN_PLACE_ENVS = "1";
  t.after(() => {
    if (original === undefined) delete process.env.SCIENCE_AGENT_IN_PLACE_ENVS;
    else process.env.SCIENCE_AGENT_IN_PLACE_ENVS = original;
  });
}

// W22: the in-place BRANCH below (bytecode judgement over the payload's own
// envs-template) is win32-only now — darwin degrades IN_PLACE to copy mode to
// keep the sealed bundle untouched. Every in-place-behaviour test pins win32
// so the branch stays exercised wherever the suite runs.
const INPLACE_PLATFORM = "win32" as const;

test("in-place mode names a payload that shipped almost no bytecode", async (t) => {
  withInPlaceEnvs(t);
  const root = await mkdtemp(join(tmpdir(), "sd-inplace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // The release6 shape: .py all present, .pyc almost none (the W25 incident was
  // 1,384 of ~37,000 = 3.6%; 1 of 20 = 5% here).
  const resources = await makePayloadFixture(root, 20, 1);
  await writeManifest(resources, { py: 20, pyc: 20 });

  const lines: string[] = [];
  const result = await bootstrapPackaged(packagedPaths(resources), join(root, "data"), (l) => lines.push(l), INPLACE_PLATFORM);
  assert.equal(result.unpacked, true, "in-place still reports provisioning");

  const warned = lines.filter((l) => l.includes("incomplete bytecode"));
  assert.equal(warned.length, 1,
    "the default install path must name an incomplete payload at first launch; got: " + JSON.stringify(lines));
  assert.match(warned[0], /in-place/, "the warning must say which tree it judged");
  assert.equal(lines.some((l) => l.includes("bytecode coverage verified")), false,
    "a 5%-covered tree must not also be reported as verified");
});

test("in-place mode catches a tree that lost whole directories", async (t) => {
  withInPlaceEnvs(t);
  const root = await mkdtemp(join(tmpdir(), "sd-inplace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Fully self-consistent but only a QUARTER of what the build recorded — the
  // shape the coverage ratio cannot see (#897 §2's "partial copy"), since the
  // missing directories took their .py and .pyc together.
  const resources = await makePayloadFixture(root, 10, 10);
  await writeManifest(resources, { py: 40, pyc: 40 });

  const lines: string[] = [];
  await bootstrapPackaged(packagedPaths(resources), join(root, "data"), (l) => lines.push(l), INPLACE_PLATFORM);
  const warned = lines.filter((l) => l.includes("incomplete bytecode"));
  assert.equal(warned.length, 1, "a 25%-of-manifest tree must be named; got: " + JSON.stringify(lines));
  assert.match(warned[0], /10 of the 40/, "the gap must be quantified against the build's own count");
});

test("in-place mode reports a healthy payload as verified", async (t) => {
  withInPlaceEnvs(t);
  const root = await mkdtemp(join(tmpdir(), "sd-inplace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = await makePayloadFixture(root, 10, 10);
  await writeManifest(resources, { py: 10, pyc: 10 });

  const lines: string[] = [];
  await bootstrapPackaged(packagedPaths(resources), join(root, "data"), (l) => lines.push(l), INPLACE_PLATFORM);
  assert.equal(lines.filter((l) => l.includes("incomplete bytecode")).length, 0,
    "a complete payload must not cry wolf; got: " + JSON.stringify(lines));
  assert.equal(lines.some((l) => l.includes("bytecode coverage verified")), true);
});

test("in-place mode verifies once per PAYLOAD, not on every launch", async (t) => {
  withInPlaceEnvs(t);
  const root = await mkdtemp(join(tmpdir(), "sd-inplace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = await makePayloadFixture(root, 10, 10);
  // A payload WITH an identity, so the stamp records which payload was judged.
  await writeManifest(resources, { py: 10, pyc: 10 }, { repoCommit: "aaaaaaa", builtAt: "2026-11-01T00:00:00Z" });

  // The in-place branch runs on EVERY launch (the stamp short-circuit above it
  // is copy-mode only), so the walk must gate itself or it taxes every cold
  // start — measured ~750ms for the real envs-template region, which this
  // project's "first run must not get slower" constraint does not allow.
  const lines: string[] = [];
  const paths = packagedPaths(resources);
  const dataDir = join(root, "data");
  await bootstrapPackaged(paths, dataDir, (l) => lines.push(l), INPLACE_PLATFORM);
  await bootstrapPackaged(paths, dataDir, (l) => lines.push(l), INPLACE_PLATFORM);

  const verified = lines.filter((l) => l.includes("bytecode coverage verified"));
  assert.equal(verified.length, 1,
    "a relaunch of the SAME payload has a matching stamp and must not re-walk; got "
    + verified.length + " verifications");
});

test("in-place mode re-judges when an upgrade replaces the payload at the same install", async (t) => {
  withInPlaceEnvs(t);
  const root = await mkdtemp(join(tmpdir(), "sd-inplace-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // F3: an upgrade keeps BOTH halves of the old stamp's identity — the install
  // root (installer.nsh restores $INSTDIR from the registry) and the pinned data
  // dir — so a gate keyed on location alone skips the judgement on the one
  // launch that installs a new payload. Drive that exactly: same dataDir,
  // same resourcesPath, only the payload identity changes between launches.
  const resources = await makePayloadFixture(root, 10, 10);
  const dataDir = join(root, "data");
  const paths = packagedPaths(resources);

  const lines: string[] = [];
  // Launch 1: the first payload. Judged, stamped with its identity.
  await writeManifest(resources, { py: 10, pyc: 10 }, { repoCommit: "aaaaaaa", builtAt: "2026-11-01T00:00:00Z" });
  await bootstrapPackaged(paths, dataDir, (l) => lines.push(l), INPLACE_PLATFORM);
  // Launch 2: relaunch of the SAME payload — must skip (the ~750ms budget).
  await bootstrapPackaged(paths, dataDir, (l) => lines.push(l), INPLACE_PLATFORM);
  assert.equal(lines.filter((l) => l.includes("bytecode coverage verified")).length, 1,
    "the same payload must be judged once, not per launch");

  // Launch 3: an upgrade drops in a new payload (different repoCommit) at the
  // same install root and data dir. The stamp's location matches, so a
  // needsUnpack gate would skip it — this is the regression the fix removes.
  await writeManifest(resources, { py: 10, pyc: 10 }, { repoCommit: "bbbbbbb", builtAt: "2026-11-07T00:00:00Z" });
  await bootstrapPackaged(paths, dataDir, (l) => lines.push(l), INPLACE_PLATFORM);
  assert.equal(lines.filter((l) => l.includes("bytecode coverage verified")).length, 2,
    "an upgraded payload must be judged again even though the install root is unchanged; got: "
    + JSON.stringify(lines));

  // And a BROKEN upgraded payload must be NAMED, not silently skipped — that is
  // the whole point of §2: the new payload is where bytecode can go missing.
  const brokenLines: string[] = [];
  await writeManifest(resources, { py: 40, pyc: 40 }, { repoCommit: "ccccccc", builtAt: "2026-11-08T00:00:00Z" });
  await bootstrapPackaged(paths, dataDir, (l) => brokenLines.push(l), INPLACE_PLATFORM);
  assert.equal(brokenLines.filter((l) => l.includes("incomplete bytecode")).length, 1,
    "an upgrade to an incomplete payload must name it at first launch; got: " + JSON.stringify(brokenLines));
});

test("a stamp written before the payload field existed is judged, not trusted", async (t) => {
  withInPlaceEnvs(t);
  const root = await mkdtemp(join(tmpdir(), "sd-inplace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = await makePayloadFixture(root, 10, 10);
  await writeManifest(resources, { py: 10, pyc: 10 }, { repoCommit: "aaaaaaa", builtAt: "2026-11-01T00:00:00Z" });
  const dataDir = join(root, "data");
  const paths = packagedPaths(resources);

  // A predecessor stamp carries installRoot + at but no payload field. Trusting
  // it would inherit an unidentified payload's verdict; the safe direction is to
  // judge (lesson L62: the direction a stale artifact can be wrong in is unsafe).
  await mkdir(join(dataDir, "envs"), { recursive: true });
  await writeFile(stampPath(dataDir), JSON.stringify({ installRoot: paths.resourcesPath, at: "2020-01-01T00:00:00Z" }), "utf8");

  const lines: string[] = [];
  await bootstrapPackaged(paths, dataDir, (l) => lines.push(l), INPLACE_PLATFORM);
  assert.equal(lines.filter((l) => l.includes("bytecode coverage verified")).length, 1,
    "a payload-less stamp must be judged rather than trusted; got: " + JSON.stringify(lines));
});

test("a payload with no manifest still judges in-place coverage", async (t) => {
  withInPlaceEnvs(t);
  const root = await mkdtemp(join(tmpdir(), "sd-inplace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // version.json absent: the ratio limit must still reject the incident shape
  // rather than passing blind on a missing input (lesson L51).
  const resources = await makePayloadFixture(root, 20, 1);

  const lines: string[] = [];
  await bootstrapPackaged(packagedPaths(resources), join(root, "data"), (l) => lines.push(l), INPLACE_PLATFORM);
  assert.equal(lines.filter((l) => l.includes("incomplete bytecode")).length, 1);
  assert.match(lines.find((l) => l.includes("incomplete bytecode")) ?? "", /no build manifest/);
});

test("in-place mode names a tree that lost sources but kept their caches", async (t) => {
  withInPlaceEnvs(t);
  const root = await mkdtemp(join(tmpdir(), "sd-inplace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // An antivirus rule that quarantines scripts and spares __pycache__. Coverage
  // is pyc/py, so this reads as HEALTHIER than the payload that shipped — 4 .py
  // left against 20 recorded, with all 20 .pyc still there = 500% — and a
  // ratio-only gate reported it verified while every orphaned cache is unusable
  // (PEP 3147 resolves a .pyc against a source that is no longer present).
  const resources = await makePayloadFixture(root, 20, 20);
  await writeManifest(resources, { py: 20, pyc: 20 });
  const sp = join(resources, "envs-template", "sd-services", "Lib", "site-packages", "pkg");
  for (let i = 0; i < 16; i += 1) await rm(join(sp, `m${i}.py`));

  const lines: string[] = [];
  await bootstrapPackaged(packagedPaths(resources), join(root, "data"), (l) => lines.push(l), INPLACE_PLATFORM);

  const warned = lines.filter((l) => l.includes("incomplete bytecode"));
  assert.equal(warned.length, 1,
    "a tree that lost its sources must be named, not reported as 500% coverage; got: " + JSON.stringify(lines));
  assert.match(warned[0], /in-place/);
  assert.match(warned[0], /4 of the 20 \.py/, "the reason must quantify the missing sources");
  assert.equal(lines.some((l) => l.includes("bytecode coverage verified")), false);
  // The promise has to match what the remedial compile can do: it cannot
  // recompile sources that are gone. Claiming a recovery here would be a log
  // that reports a fix which never happened (problems W25 item 5).
  assert.match(warned[0], /cannot restore files that are gone/);
  assert.equal(warned[0].includes("Attempting a first-launch compile to recover it"), false,
    "the source-loss shape must not promise the cache-loss recovery");
});
// --- copy mode: the same check on the unpack branch -------------------------
//
// The copy branch was wired first, but its only proof was a source-text guard —
// exactly the kind that failed to catch the in-place gap (lesson L55). These
// drive the real unpack so both branches are pinned behaviourally, and so the
// two cannot silently diverge. Copy mode is the default in dev/CI (no
// SCIENCE_AGENT_IN_PLACE_ENVS), which is also why the suite exercises it.

test("copy mode names an incomplete payload at first launch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sd-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = await makePayloadFixture(root, 20, 1);
  await writeManifest(resources, { py: 20, pyc: 20 });

  const dataDir = join(root, "data");
  const lines: string[] = [];
  const result = await bootstrapPackaged(packagedPaths(resources), dataDir, (l) => lines.push(l));
  assert.equal(result.unpacked, true);
  // The copy lands in <dataDir>\envs and is what gets judged.
  assert.equal(existsSync(join(dataDir, "envs", "sd-services")), true);

  const warned = lines.filter((l) => l.includes("incomplete bytecode"));
  assert.equal(warned.length, 1, "the unpack branch must name an incomplete copy; got: " + JSON.stringify(lines));
  assert.match(warned[0], /copied/, "the warning must say it judged the copied tree");
});

test("copy mode verifies a healthy unpack", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sd-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = await makePayloadFixture(root, 10, 10);
  await writeManifest(resources, { py: 10, pyc: 10 });

  const lines: string[] = [];
  await bootstrapPackaged(packagedPaths(resources), join(root, "data"), (l) => lines.push(l));
  assert.equal(lines.filter((l) => l.includes("incomplete bytecode")).length, 0,
    "a complete copy must not warn; got: " + JSON.stringify(lines));
  assert.equal(lines.some((l) => l.includes("bytecode coverage verified")), true);
});

test("copy mode does not re-verify on the second launch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sd-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = await makePayloadFixture(root, 10, 10);
  await writeManifest(resources, { py: 10, pyc: 10 });

  const paths = packagedPaths(resources);
  const dataDir = join(root, "data");
  const lines: string[] = [];
  await bootstrapPackaged(paths, dataDir, (l) => lines.push(l));
  await bootstrapPackaged(paths, dataDir, (l) => lines.push(l));
  // The second launch short-circuits on the valid stamp before the copy branch.
  assert.equal(lines.filter((l) => l.includes("bytecode coverage verified")).length, 1,
    "a valid stamp must short-circuit the copy branch on relaunch");
});

test("copy mode names a copy that lost sources but kept their caches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sd-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Same quarantine shape through the unpack branch, so the two cannot diverge:
  // both call judgeBytecodeCoverage, and this pins that the shared helper's new
  // .py limit is live on both paths rather than only where it was added.
  const resources = await makePayloadFixture(root, 20, 20);
  await writeManifest(resources, { py: 20, pyc: 20 });
  const sp = join(resources, "envs-template", "sd-services", "Lib", "site-packages", "pkg");
  for (let i = 0; i < 16; i += 1) await rm(join(sp, `m${i}.py`));

  const dataDir = join(root, "data");
  const lines: string[] = [];
  await bootstrapPackaged(packagedPaths(resources), dataDir, (l) => lines.push(l));

  const warned = lines.filter((l) => l.includes("incomplete bytecode"));
  assert.equal(warned.length, 1, "the unpack branch must name it too; got: " + JSON.stringify(lines));
  assert.match(warned[0], /copied/);
  assert.match(warned[0], /4 of the 20 \.py/);
  assert.match(warned[0], /cannot restore files that are gone/);
});
