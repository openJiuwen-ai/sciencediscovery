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
  bootstrapPackaged, compileallArgs, copyTreeConcurrent, countBytecode, needsUnpack, packagedEnv, packagedPaths,
  precompileTargets, readPayloadBytecodeManifest, rewriteEditablePth, rewritePyvenvHome, stampPath, treeHasPycache,
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
  // SIZEOPT W2: one shared venv for all five Python sidecars.
  assert.ok(p.venvNames.includes("sd-services"));
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

test("in-place mode names a payload that shipped almost no bytecode", async (t) => {
  withInPlaceEnvs(t);
  const root = await mkdtemp(join(tmpdir(), "sd-inplace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // The release6 shape: .py all present, .pyc almost none (the W25 incident was
  // 1,384 of ~37,000 = 3.6%; 1 of 20 = 5% here).
  const resources = await makePayloadFixture(root, 20, 1);
  await writeManifest(resources, { py: 20, pyc: 20 });

  const lines: string[] = [];
  const result = await bootstrapPackaged(packagedPaths(resources), join(root, "data"), (l) => lines.push(l));
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
  await bootstrapPackaged(packagedPaths(resources), join(root, "data"), (l) => lines.push(l));
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
  await bootstrapPackaged(packagedPaths(resources), join(root, "data"), (l) => lines.push(l));
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
  await bootstrapPackaged(paths, dataDir, (l) => lines.push(l));
  await bootstrapPackaged(paths, dataDir, (l) => lines.push(l));

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
  await bootstrapPackaged(paths, dataDir, (l) => lines.push(l));
  // Launch 2: relaunch of the SAME payload — must skip (the ~750ms budget).
  await bootstrapPackaged(paths, dataDir, (l) => lines.push(l));
  assert.equal(lines.filter((l) => l.includes("bytecode coverage verified")).length, 1,
    "the same payload must be judged once, not per launch");

  // Launch 3: an upgrade drops in a new payload (different repoCommit) at the
  // same install root and data dir. The stamp's location matches, so a
  // needsUnpack gate would skip it — this is the regression the fix removes.
  await writeManifest(resources, { py: 10, pyc: 10 }, { repoCommit: "bbbbbbb", builtAt: "2026-11-07T00:00:00Z" });
  await bootstrapPackaged(paths, dataDir, (l) => lines.push(l));
  assert.equal(lines.filter((l) => l.includes("bytecode coverage verified")).length, 2,
    "an upgraded payload must be judged again even though the install root is unchanged; got: "
    + JSON.stringify(lines));

  // And a BROKEN upgraded payload must be NAMED, not silently skipped — that is
  // the whole point of §2: the new payload is where bytecode can go missing.
  const brokenLines: string[] = [];
  await writeManifest(resources, { py: 40, pyc: 40 }, { repoCommit: "ccccccc", builtAt: "2026-11-08T00:00:00Z" });
  await bootstrapPackaged(paths, dataDir, (l) => brokenLines.push(l));
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
  await bootstrapPackaged(paths, dataDir, (l) => lines.push(l));
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
  await bootstrapPackaged(packagedPaths(resources), join(root, "data"), (l) => lines.push(l));
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
  await bootstrapPackaged(packagedPaths(resources), join(root, "data"), (l) => lines.push(l));

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
