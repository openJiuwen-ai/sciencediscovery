// Pins every dead-weight sweep rule in scripts/lib/payload-slim.mjs.
// Field lesson source: f26 payload audit (2026-11-02) — the swept packages
// carried zero runtime references in jiuwenswarm/openjiuwen, so they shipped
// as pure ballast. The false-positive cases (uvicorn vs uv, genai vs adk)
// encode real near-misses: a prefix match on "uv" or a whole-namespace
// delete of "google" would have broken live services.
//
// The babel test below records the OPPOSITE failure: that same audit produced a
// false NEGATIVE. "zero runtime references in jiuwenswarm/openjiuwen" is true of
// babel too — nothing first-party imports it — but it is a hard transitive dep
// (openjiuwen -> trafilatura -> courlan -> babel), so sweeping it silently
// degraded the HTML compressor in the shipped payload. A first-party import scan
// cannot justify removing a package a third-party dependency needs; the
// re-runnable check for that is probe-payload-runtime.py (A1b build gate), and
// this test is the always-run half of the same guard.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join, relative } from "node:path";
import {
  JW_VENV_SWEEP_RULES,
  matchJwVenvSweep,
  isDeadVenvScript,
  codexVendorDirs,
  leftoverCodexVendorDirs,
  CODEX_VENDOR_MARKER,
} from "../scripts/lib/payload-slim.mjs";

test("dead packages and their dist-info dirs are swept", () => {
  for (const name of [
    "kubernetes", "kubernetes-31.0.0.dist-info",
    "onnxruntime", "onnxruntime-1.23.2.dist-info",
    "google_adk", "google_adk-2.1.0.dist-info",
    "mypy", "mypy-2.1.0.dist-info",
    "mypy_extensions", "mypy_extensions-1.1.0.dist-info",
    "ruff", "pylint", "codespell", "astroid", "mccabe",
    "claude_agent_sdk", "claude_agent_sdk-0.2.115.dist-info",
    "playwright", "playwright-1.54.0.dist-info",
    "uv", "uv-0.11.16.dist-info",
  ]) {
    assert.ok(matchJwVenvSweep(name), `expected sweep: ${name}`);
  }
});

// babel used to be in the list above. It is a HARD transitive dependency of the
// product and must never be swept again:
//   openjiuwen METADATA:38   Requires-Dist: trafilatura>=1.6.0
//   trafilatura METADATA:42  Requires-Dist: courlan>=1.4.0
//   courlan METADATA         Requires-Dist: babel>=2.16.0   (no extra marker)
//   courlan/filters.py:11    from babel import Locale, UnknownLocaleError
// openjiuwen's HTML compressor imports trafilatura lazily and unguarded
// (html_compressor.py:55), rule compression is on by default
// (message_offloader.py:29 hardcodes "rule_then_truncate"), and compress()
// swallows the resulting ModuleNotFoundError into a beautifulsoup fallback — so
// sweeping babel shipped a silent functional regression (title/author/date all
// None) with no error and no log. The old rule justified itself as a "jinja2
// hard dep"; jinja2 is not installed in the JW venv at all.
// This test is the cheap, always-run half of the guard. The expensive half is
// probe-payload-runtime.py assertion 4, which actually runs the compressor in
// the assembled payload during the build (A1b gate).
test("babel is never a sweep target, under any spelling", () => {
  for (const name of [
    "babel", "Babel",
    "babel-2.18.0.dist-info", "Babel-2.17.0.dist-info",
    "babel.core", "babeljs",
  ]) {
    assert.equal(matchJwVenvSweep(name), null, `must keep: ${name}`);
  }
  // Belt and braces: not merely unmatched today, but absent from the rule list,
  // so a future rule cannot reintroduce it by matching something broader.
  for (const rule of JW_VENV_SWEEP_RULES) {
    assert.ok(!rule.match.toLowerCase().includes("babel"),
      `a sweep rule still targets babel: ${rule.match}`);
  }
  // pybabel.exe (the i18n message-extraction CLI) IS swept — that stays correct,
  // since nothing at runtime invokes it (0 references across jiuwenswarm and
  // openjiuwen). Sweeping the launcher while keeping the importable package is
  // deliberate; assert both halves so the distinction does not get "fixed" by
  // someone who only reads one of the two tests.
  assert.equal(isDeadVenvScript("pybabel.exe"), true);
});

test("live packages survive — prefix near-misses", () => {
  for (const name of [
    "uvicorn", "uvicorn-0.53.0.dist-info",   // must NOT match the "uv" rule
    "numpy", "pandas", "lark_oapi", "chromadb", "faiss", "transformers",
    "google", "google.adk",                  // namespace parent stays
    "mypybot",                                  // exact-match only
    "playwright_stealth",                       // exact-match only
    "kubernetes_asyncio",                       // not a real dep, but prefix-safe anyway
    "uvloop", "uvicorn-0.53.0.dist-info",
  ]) {
    assert.equal(matchJwVenvSweep(name), null, `must keep: ${name}`);
  }
});

test("nested google namespace: only adk subtree is swept", () => {
  const nested = JW_VENV_SWEEP_RULES.filter((r) => r.match.includes("/")).map((r) => r.match);
  assert.deepEqual(nested, ["google/adk"]);
  assert.equal(matchJwVenvSweep("google/adk"), null, "nested paths are caller-driven, not top-level matches");
});

test("venv Scripts dev tools are swept, runtime launchers survive", () => {
  for (const dead of ["uv.exe", "uvx.exe", "mypy.exe", "dmypy.exe", "stubtest.exe",
    "stubgen.exe", "pylint.exe", "codespell.exe", "pybabel.exe", "playwright.exe"]) {
    assert.ok(isDeadVenvScript(dead), `expected dead script: ${dead}`);
  }
  for (const live of ["python.exe", "pythonw.exe", "jiuwenswarm.exe",
    "jiuwenswarm-gateway.exe", "jiuwenswarm-agentserver.exe", "jiuwenbox.exe"]) {
    assert.equal(isDeadVenvScript(live), false, `must keep script: ${live}`);
  }
});

// The codex sweep used to be one hardcoded path, `CODEX_VENDOR_SEGMENTS`,
// pinned by an assert that compared the literal to itself. That proved
// nothing about the payload: the path only exists because assemble-backend
// happens to pick the JS wrapper as @openai/codex's "primary" version today,
// which flips to the platform package under a different readdir order. These
// build real (throwaway) node_modules trees instead, so they assert what the
// sweep finds rather than how it is spelled.

/** Build a throwaway flattened node_modules root containing `relPaths`. */
function makePayload(relPaths: string[]) {
  const root = mkdtempSync(join(tmpdir(), "payload-slim-"));
  for (const rel of relPaths) mkdirSync(join(root, ...rel.split("/")), { recursive: true });
  return root;
}

/** Relative POSIX paths of what the sweep reported, sorted for comparison. */
function found(root: string) {
  return codexVendorDirs(root).map((d) => relative(root, d).split("\\").join("/")).sort();
}

/** @openai/codex nested under itself `levels` times, with a vendor at the end.
 * levels=1 is the flat root, levels=2 is one consumer nesting. */
function nestedCodex(levels: number) {
  let p = "@openai/codex";
  for (let i = 1; i < levels; i += 1) p += "/node_modules/@openai/codex";
  return `${p}/vendor`;
}

test("codex vendor sweep finds the shape release5 actually shipped", () => {
  // release5-assemble.log:11 — the wrapper won primary and the platform
  // package nested underneath it. This is the case that carries the 437 MB.
  const root = makePayload(["@openai/codex/node_modules/@openai/codex/vendor/bin/codex"]);
  try {
    assert.deepEqual(found(root), ["@openai/codex/node_modules/@openai/codex/vendor"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex vendor sweep also finds the flat and alias shapes", () => {
  // If primary flips to the platform package, its vendor lands at the flat
  // root; if an alias dir keeps its own name, it lands under codex-<platform>.
  // Either way the sweep must still fire, or the win silently evaporates.
  const root = makePayload([
    "@openai/codex/vendor",
    "@openai/codex-win32-x64/vendor",
    "@openai/codex-linux-x64/vendor",
    "@openai/codex-darwin-arm64/vendor",
  ]);
  try {
    assert.deepEqual(found(root), [
      "@openai/codex-darwin-arm64/vendor",
      "@openai/codex-linux-x64/vendor",
      "@openai/codex-win32-x64/vendor",
      "@openai/codex/vendor",
    ].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex vendor sweep keeps the JS SDK and unrelated scope entries", () => {
  // @openai/codex-sdk is what services/api imports (launcher.ts resolves the
  // CLI through it), so it must survive. A bare "codex-" prefix rule would
  // sweep it too — today only luck (the SDK ships no vendor dir) hides that.
  const root = makePayload([
    "@openai/codex-sdk/vendor",
    "@openai/codex-something-else/vendor",
    "@openai/codex/vendor",
    "@openai/other/vendor",
  ]);
  try {
    assert.deepEqual(found(root), ["@openai/codex/vendor"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex vendor sweep finds the shape a platform package winning primary creates", () => {
  // The fourth shape, and the one the previous (name-gated) walk could not
  // reach: pnpm installs the six platform packages through npm aliases, so
  // their package.json name is also "@openai/codex" — all seven versions share
  // one realDirs key and every one has exactly one consumer, which makes
  // assemble-backend.mjs's "ties to first seen" readdir order the whole
  // primary decision. When a PLATFORM package wins, the JS wrapper is no
  // longer primary and gets nested under its consumer, which is the SDK:
  //   @openai/codex-sdk/node_modules/@openai/codex/node_modules/@openai/codex/vendor
  // "codex-sdk" is not a sweep target (services/api imports it), so a walk
  // gated on the name never entered its node_modules. Measured by replaying
  // primaryOf/locations over pnpm-lock.yaml:2994-3023: the gated walk found 1
  // of 3 distinct package dirs in that ordering. Descent is now ungated; the
  // name filter decides only what is COLLECTED.
  const root = makePayload([
    "@openai/codex-sdk/node_modules/@openai/codex/node_modules/@openai/codex/vendor/bin/codex",
    "@openai/codex-sdk/node_modules/@openai/codex/vendor/bin/codex",
    "@openai/codex/vendor/bin/codex",
  ]);
  try {
    assert.deepEqual(found(root), [
      "@openai/codex-sdk/node_modules/@openai/codex/node_modules/@openai/codex/vendor",
      "@openai/codex-sdk/node_modules/@openai/codex/vendor",
      "@openai/codex/vendor",
    ].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex vendor sweep still keeps the SDK itself when it hosts a nested wrapper", () => {
  // The ungated descent must not turn into "delete everything under @openai".
  // codex-sdk is the SDK the api imports, so its own dir must never be
  // collected even though the walk now walks through it.
  const root = makePayload([
    "@openai/codex-sdk/vendor",
    "@openai/codex-sdk/dist/index.js",
    "@openai/codex-sdk/node_modules/@openai/codex/node_modules/@openai/codex/vendor",
    "@openai/other/vendor",
  ]);
  try {
    assert.deepEqual(found(root), [
      "@openai/codex-sdk/node_modules/@openai/codex/node_modules/@openai/codex/vendor",
    ]);
    assert.ok(existsSync(join(root, "@openai", "codex-sdk", "vendor")), "the SDK survives");
    assert.ok(existsSync(join(root, "@openai", "other", "vendor")), "unrelated scope survives");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex vendor sweep finds every dir the real flatten emits, in both primary orderings", () => {
  // Regression guard derived from assemble-backend.mjs itself rather than from
  // a hand-spelled path: replay its consumerCount / primaryOf / locations
  // fixed point (assemble-backend.mjs:303-351) over the dependency graph in
  // pnpm-lock.yaml:2994-3023, in the two readdir orders that can flip the
  // primary, and assert the sweep finds all of the emitted package dirs.
  // Re-introducing a name gate on the descent fails here on the
  // platform-primary ordering.
  const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64",
    "win32-arm64", "win32-x64"];
  const V = "0.162.1";

  interface Pkg { name: string; version: string; deps: { name: string; version: string }[] }

  /** The graph the lock describes: the SDK depends on the wrapper; the wrapper
   * optionally depends on six npm aliases whose package.json name is still
   * "@openai/codex" (pnpm-lock.yaml:2994-3023). */
  const spec = (key: string): Pkg => {
    if (key === "@openai+codex-sdk@0.162.1") {
      return { name: "@openai/codex-sdk", version: V, deps: [{ name: "@openai/codex", version: V }] };
    }
    if (key === `@openai+codex@${V}`) {
      return {
        name: "@openai/codex", version: V,
        deps: PLATFORMS.map((p) => ({ name: "@openai/codex", version: `${V}-${p}` })),
      };
    }
    const platform = key.slice(`@openai+codex@${V}-`.length);
    return { name: "@openai/codex", version: `${V}-${platform}`, deps: [] };
  };

  /** primaryOf + the nesting fixed point, transcribed from assemble-backend. */
  const emittedDirs = (keys: string[]): string[] => {
    const pkgs = keys.map(spec);
    const versionsOf = new Map<string, string[]>();
    for (const p of pkgs) {
      if (!versionsOf.has(p.name)) versionsOf.set(p.name, []);
      if (!versionsOf.get(p.name)!.includes(p.version)) versionsOf.get(p.name)!.push(p.version);
    }
    const consumerCount = new Map<string, number>();
    for (const p of pkgs) {
      for (const d of p.deps) {
        const id = `${d.name}@${d.version}`;
        consumerCount.set(id, (consumerCount.get(id) ?? 0) + 1);
      }
    }
    const primaryOf = new Map<string, string>();
    for (const [name, versions] of versionsOf) {
      let best = ""; let bestCount = -1;
      for (const version of versions) {
        const count = consumerCount.get(`${name}@${version}`) ?? 0;
        if (count > bestCount) { best = version; bestCount = count; }
      }
      primaryOf.set(name, best);
    }
    const locations = new Map<string, string[]>();
    for (const name of versionsOf.keys()) {
      locations.set(`${name}@${primaryOf.get(name)}`, [name]);
    }
    for (let round = 0; round < 5; round += 1) {
      let changed = false;
      for (const [i, p] of pkgs.entries()) {
        const consumerLocs = locations.get(`${p.name}@${p.version}`);
        if (!consumerLocs) continue;
        for (const d of p.deps) {
          if (primaryOf.get(d.name) === d.version) continue;
          const id = `${d.name}@${d.version}`;
          const nested = consumerLocs.map((l) => `${l}/node_modules/${d.name}`);
          const existing = locations.get(id) ?? [];
          const merged = [...new Set([...existing, ...nested])];
          if (merged.length !== existing.length) { locations.set(id, merged); changed = true; }
        }
      }
      if (!changed) break;
    }
    return [...new Set([...locations]
      .filter(([k]) => k.startsWith("@openai/codex@"))
      .flatMap(([, v]) => v))];
  };

  const orderings: [string, string[]][] = [
    ["wrapper wins primary (the ordering release5 shipped)",
      ["@openai+codex-sdk@0.162.1", `@openai+codex@${V}`,
        ...PLATFORMS.map((p) => `@openai+codex@${V}-${p}`)]],
    ["platform package wins primary",
      [`@openai+codex@${V}-win32-x64`, "@openai+codex-sdk@0.162.1", `@openai+codex@${V}`,
        ...PLATFORMS.filter((p) => p !== "win32-x64").map((p) => `@openai+codex@${V}-${p}`)]],
  ];

  for (const [label, keys] of orderings) {
    const dirs = emittedDirs(keys);
    assert.ok(dirs.length >= 2, `${label}: expected a nested flatten, got ${JSON.stringify(dirs)}`);
    const root = makePayload(dirs.map((d) => `${d}/vendor/bin/codex`));
    try {
      assert.deepEqual(found(root), dirs.map((d) => `${d}/vendor`).sort(), label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("codex vendor sweep is a no-op when there is nothing to sweep", () => {
  // Absence must not throw: assemble runs on trees that never carried codex.
  const empty = makePayload([]);
  try {
    assert.deepEqual(found(empty), []);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  const noScope = makePayload(["express/index.js"]);
  try {
    assert.deepEqual(found(noScope), []);
  } finally {
    rmSync(noScope, { recursive: true, force: true });
  }
});

test("codex vendor sweep stops descending at the nesting bound", () => {
  // Put a vendor at every level so the assertion shows exactly where the walk
  // stops: MAX_CODEX_NESTING=4 admits depths 0..4, i.e. the first five copies
  // (pnpm emits two at most). A symlinked or self-nesting tree therefore
  // cannot spin the enumeration, and the cut is a stated bound, not luck.
  const root = makePayload([1, 2, 3, 4, 5, 6, 7].map(nestedCodex));
  try {
    assert.deepEqual(found(root), [1, 2, 3, 4, 5].map(nestedCodex).sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the caller loop removes every vendor and then finds none", () => {
  // This is exactly what assemble-backend.mjs:474-483 does: enumerate, rm each,
  // log. Sweeping once must leave nothing behind — a second pass finding a
  // vendor would mean the enumeration missed a shape and shipped 437 MB.
  const root = makePayload([
    "@openai/codex/vendor",
    "@openai/codex/node_modules/@openai/codex/vendor",
    "@openai/codex-win32-x64/vendor",
    "@openai/codex-sdk/vendor", // stays; not a sweep target
  ]);
  try {
    for (const vendor of codexVendorDirs(root)) {
      rmSync(vendor, { recursive: true, force: true });
    }
    // Nothing a sweep target remains...
    assert.deepEqual(found(root), []);
    // ...and the SDK vendor was left alone, proving the enumeration is not
    // simply deleting every vendor dir it walks past.
    assert.ok(
      existsSync(join(root, "@openai", "codex-sdk", "vendor")),
      "the SDK vendor must survive the sweep",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Post-sweep verification (review finding F12).
//
// codexVendorDirs deletes; leftoverCodexVendorDirs checks that the delete
// happened. The two MUST NOT share a name rule, or the check is circular: when
// CODEX_SWEEP_DIR stops matching, the sweep deletes nothing and a name-based
// check finds nothing too — both green, 437 MB shipped. F4 is the instance that
// makes this concrete (the original sweep targeted a path that could not exist
// in the flattened payload; only a human reading the code noticed).
// ---------------------------------------------------------------------------

/** The triple dir a real toolchain puts its marker in, relative to a vendor.
 * makePayload creates DIRECTORIES, so this is what gets passed to it; the marker
 * file itself is written by writeMarker below. Measured in the pnpm store: a
 * vendored codex ships `vendor/<triple>/codex-package.json`, and
 * @openai/codex-sdk ships none. */
const VENDOR_TRIPLE = "x86_64-pc-windows-msvc";
const markedVendor = (vendorRel: string) => `${vendorRel}/${VENDOR_TRIPLE}`;

/** Drop the content marker into an already-created triple dir. */
function writeMarker(root: string, tripleRel: string) {
  writeFileSync(join(root, ...tripleRel.split("/"), CODEX_VENDOR_MARKER), "{}");
}

function leftovers(root: string) {
  return leftoverCodexVendorDirs(root)
    .map((d) => relative(root, d).split("\\").join("/"))
    .sort();
}

test("leftover check sees nothing after a successful sweep", () => {
  const tripleDirs = [
    markedVendor("@openai/codex/node_modules/@openai/codex/vendor"),
    markedVendor("@openai/codex-win32-x64/vendor"),
  ];
  const root = makePayload(tripleDirs);
  try {
    for (const t of tripleDirs) writeMarker(root, t);
    // The fixture must start non-empty, or the "[]" below would pass on a tree
    // that never carried a toolchain at all.
    assert.ok(leftovers(root).length === 2,
      `fixture is wrong: expected 2 marked vendors, got ${JSON.stringify(leftovers(root))}`);
    for (const v of codexVendorDirs(root)) rmSync(v, { recursive: true, force: true });
    assert.deepEqual(leftovers(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leftover check still fires when the sweep's name rule matches NOTHING", () => {
  // The circularity proof, and the whole reason this check exists. Every dir
  // here is named so CODEX_SWEEP_DIR rejects it — exactly what a renamed alias
  // or a new flattener layout produces, and exactly what F4 shipped. So:
  //   codexVendorDirs        -> []   (deletes nothing, and would stay silent)
  //   leftoverCodexVendorDirs-> finds it, because the marker is content, not name
  const triple = markedVendor("@openai/codex-renamed-by-a-future-pnpm/vendor");
  const root = makePayload([triple]);
  try {
    writeMarker(root, triple);
    // Precondition: the sweep really cannot see this, so a green sweep result is
    // NOT evidence of a clean tree. Assert it rather than assuming it.
    assert.deepEqual(found(root), [],
      "fixture is wrong: the name rule matched, so this case tests nothing");
    assert.deepEqual(
      leftovers(root),
      ["@openai/codex-renamed-by-a-future-pnpm/vendor"],
      "a toolchain the name rule cannot reach must still be reported",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leftover check does not mistake the SDK or an unrelated vendor for a toolchain", () => {
  // typescript ships a dir named `vendor` too (measured in the pnpm store), so
  // a name-based leftover check would either flag it or have to relearn which
  // names to trust — the circularity this avoids. The marker is the only
  // evidence, and the SDK does not ship one.
  const root = makePayload([
    markedVendor("@openai/codex-sdk/vendor"),
    "typescript/vendor/lib",
    "express/index.js",
  ]);
  try {
    assert.deepEqual(leftovers(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leftover check finds the deepest shape the flattener can emit", () => {
  // The platform-wins-primary shape from F4's suggestion: the wrapper nested
  // under the SDK, a platform package nested under the wrapper. The marker has
  // to survive a walk that no longer cares which package NAME it passed through.
  const deep = "@openai/codex-sdk/node_modules/@openai/codex/node_modules/@openai/codex/vendor";
  const triple = markedVendor(deep);
  const root = makePayload([triple]);
  try {
    writeMarker(root, triple);
    assert.deepEqual(leftovers(root), [deep]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leftover check reports each distinct vendor once", () => {
  // A real toolchain carries a marker under EVERY triple it bundles, so one
  // vendor dir can hold several. It must yield one entry, or the failure message
  // would repeat a path and the count would not mean anything.
  const root = makePayload([
    markedVendor("@openai/codex/vendor"),
    "@openai/codex/vendor/x86_64-unknown-linux-musl",
  ]);
  try {
    writeMarker(root, markedVendor("@openai/codex/vendor"));
    writeMarker(root, "@openai/codex/vendor/x86_64-unknown-linux-musl");
    assert.deepEqual(leftovers(root), ["@openai/codex/vendor"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leftover check ignores a marker that is not inside a vendor dir", () => {
  // Guards the vendorAncestor walk: a stray codex-package.json anywhere else
  // (a test fixture, a docs tree) must not be promoted into a false leftover.
  const root = makePayload(["@openai/codex/dist"]);
  try {
    writeMarker(root, "@openai/codex/dist");
    assert.deepEqual(leftovers(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the marker constant names the file the real toolchain ships", () => {
  // Pin the constant to the measured reality instead of to itself: the pnpm
  // store on this machine has exactly one such file, under the win32-x64
  // platform package, and none under @openai/codex-sdk. If the upstream package
  // renames it, this fails here rather than turning the check into a no-op.
  assert.equal(CODEX_VENDOR_MARKER, "codex-package.json");
  // vendorAncestor recognises a toolchain by walking up to a dir named exactly
  // "vendor", so the marker must sit inside that subtree for the walk to find it.
  assert.equal(
    basename(dirname(join("@openai", "codex", "vendor", VENDOR_TRIPLE, CODEX_VENDOR_MARKER))),
    VENDOR_TRIPLE,
  );
});
