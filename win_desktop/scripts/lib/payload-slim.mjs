// Dead-weight sweep rules for the bundled JiuwenSwarm venv (assemble-backend
// stage 5) and the api node_modules. Extracted to lib so every rule is
// unit-testable (same pattern as jw-src-filter.mjs).
//
// Evidence for each rule: the 2026-11-02 size audit (a source-level import scan
// of jiuwenswarm + openjiuwen plus a reverse-dependency walk of every pruned
// package). That audit ran offline on one machine, so it is cited here as the
// ORIGIN of each rule, not as its re-runnable proof. The re-runnable proof now
// lives in-repo: scripts/probe-payload-runtime.py, wired into assemble-backend
// as the A1b gate, and it covers BOTH ways a rule can be wrong:
//
//   * a dependency imported LAZILY, so a module-scope scan cannot see it at all
//     — onnxruntime (chromadb imports it inside its default embedding function)
//     and kubernetes (chromadb's distributed segment client). The probe asserts
//     chromadb's default-embedding fallback still fails with its own readable
//     ValueError rather than a bare ModuleNotFoundError.
//   * a dependency reached through a TRANSITIVE chain the scan never walked. The
//     scan covered jiuwenswarm + openjiuwen only, so it could not see that
//     trafilatura (imported lazily by openjiuwen's HTML compressor) pulls in
//     courlan, which requires babel at module scope. That is how the babel rule
//     shipped a silent regression; see the note where the rule used to be. The
//     probe now runs the product's own HtmlCompressor and fails the build if it
//     degrades to the beautifulsoup fallback.
//
// If a sweep removes something the runtime needs, A1b fails the build instead of
// shipping it. Rules here are still a SWEEP BACKSTOP: fresh trees should not
// contain these at all (setup syncs with --no-default-groups, JW patch 0018
// drops playwright/uv from pyproject), but a stale data dir must not be able to
// ship them again — same philosophy as the sweepNodeModules backstop in
// assemble-backend.mjs. Every sweep is best-effort: absence is fine, presence is
// removed.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * @typedef {Object} SweepRule
 * @property {string} match Exact top-level dir/file name, or dist-info stem prefix.
 * @property {boolean} distInfo True when <match>-<version>.dist-info directories count as hits.
 * @property {string} why Free-text audit citation; lands in the build log when the rule fires.
 */

/** @type {SweepRule[]} */
export const JW_VENV_SWEEP_RULES = [
  { match: "kubernetes", distInfo: true,
    why: "chromadb's DISTRIBUTED segment client only (segment/impl/distributed/segment_directory.py:4, module scope). openjiuwen builds the EMBEDDED client — ChromaVectorStore uses chromadb.PersistentClient (core/foundation/store/vector/chroma_vector_store.py:50) — so that module is never imported. Verified: import chromadb + a store write/query succeed in the swept venv (probe-payload-runtime.py)." },
  { match: "onnxruntime", distInfo: true,
    why: "chromadb's DEFAULT embedding function only, imported lazily (utils/embedding_functions/onnx_mini_lm_l6_v2.py:70) — so `import chromadb` stays green either way and a module-scope scan cannot see it. openjiuwen never reaches it: ChromaVectorStore creates collections without an embedding_function (:145) and search() passes query_embeddings only (:504); query_texts appears 0 times in that file. The one query_texts caller is core/retrieval/vector_store/chroma_store.py:318 (sparse_search), and jiuwenswarm's source tree has 0 retriever references, so that path is unreachable in the product. chromadb's own guard turns the missing package into a readable ValueError, not a bare ModuleNotFoundError — probe-payload-runtime.py asserts exactly that." },
  // babel is NOT swept, and must not be: the rule that used to sit here was
  // wrong and shipped a silent functional regression. Its justification read
  // "jinja2 hard dep, but no runtime path touches jinja2.ext.i18n" — but jinja2
  // is not installed in the JW venv at all, so the rule cited a package that
  // does not exist. The real reverse dependency is courlan, which requires
  // babel>=2.16.0 unconditionally (its METADATA has no extra marker; mako's
  // Babel dep IS extra-gated, courlan's is not) and imports it at module scope
  // (courlan/filters.py:11). trafilatura imports courlan at module scope too
  // (trafilatura/__init__.py:17 -> downloads.py:22 -> courlan/__init__.py:16 ->
  // filters.py), and openjiuwen's HTML compressor imports trafilatura lazily
  // with no guard (html_compressor.py:55). Rule compression is on by default —
  // _OFFLOAD_STRATEGY is the hardcoded "rule_then_truncate"
  // (message_offloader.py:29) and :520 enables it for anything but
  // "truncate_only" — so this path is reachable in normal use.
  // Measured A/B/C on the same HTML through the product's own HtmlCompressor, now
  // pinned in-repo by probe-payload-runtime.py assertion 4 (its docstring records
  // the chain): with babel, extractor=trafilatura and title/author/date are
  // extracted; without it, trafilatura raises ModuleNotFoundError, compress()
  // catches it and silently falls back to beautifulsoup with title/author/date
  // all None; adding babel back to the swept venv restores trafilatura exactly.
  // No crash, no log — just a worse extraction on every HTML compression in the
  // shipped payload.
  // Do not "save" the bytes by deleting babel/locale-data either: that directory
  // IS the package (of babel's 29.4 MiB apparent size, locale-data is 28.5 MiB —
  // 97%; the whole sweep removed 29.5 MiB counting dist-info), and without it
  // Locale.parse raises FileNotFoundError for EVERY valid locale, which courlan's
  // `except (TypeError, UnknownLocaleError)` at filters.py:185 does not catch —
  // that turns a silent degradation into a crash. Keeping the full package is the
  // only correct option; probe assertion 4 fails the build if it is ever swept.
  { match: "google/adk", distInfo: false,
    why: "google_adk namespace dir; JW imports only a2ui.parser/schema — the google.adk-chaining a2ui.adk submodule is never imported (f26 audit: 0 refs)" },
  { match: "google_adk", distInfo: true,
    why: "google-adk wheel metadata for the namespace above" },
  { match: "mypy", distInfo: true,
    why: "lint-group dev tool; runtime code never imports it (f26 audit). Fresh trees lack it; sweep backstops stale ones" },
  { match: "mypy_extensions", distInfo: true, why: "mypy's runtime helper; goes with mypy" },
  { match: "ruff", distInfo: true, why: "lint-group dev tool (ruff.exe already filtered elsewhere)" },
  { match: "pylint", distInfo: true, why: "lint-group dev tool" },
  { match: "codespell", distInfo: true, why: "lint-group dev tool" },
  { match: "astroid", distInfo: true, why: "pylint dependency; goes with pylint" },
  { match: "mccabe", distInfo: true, why: "pylint dependency; goes with pylint" },
  { match: "claude_agent_sdk", distInfo: true,
    why: "openjiuwen[claude] extra no longer installed (setup syncs without extras); external_cli_runtime find_spec-degrades to not_installed" },
  { match: "playwright", distInfo: true,
    why: "JW patch 0018 removes the pyproject dep (only 2 skill scripts used it, lazily); sweep backstops stale trees" },
  { match: "uv", distInfo: true,
    why: "JW patch 0018 removes the pyproject dep; every runtime caller (upgrade_executor/extensions loader) has a pip or None fallback" },
];

// Nested site-packages paths swept in addition to top-level rules (the google
// namespace package stays; only its adk subtree goes).
export const JW_VENV_SWEEP_NESTED = ["google/adk"];

// Venv Scripts/ entries swept alongside site-packages (build tools, not
// runtime binaries). Predicate over the bare file name.
//
// pybabel.exe is swept while the babel PACKAGE is deliberately kept (see the
// note in JW_VENV_SWEEP_RULES — courlan needs it at module scope). That is not a
// contradiction: the console script is babel's i18n message-extraction CLI, a
// build-time tool, and nothing at runtime invokes it (0 references to "pybabel"
// across the jiuwenswarm source tree and openjiuwen). Same split as mypy.exe vs
// mypy_extensions: the launcher goes, an importable dependency stays.
export function isDeadVenvScript(name) {
  return name === "uv.exe" || name === "uvx.exe" || name === "mypy.exe"
    || name === "dmypy.exe" || name === "stubtest.exe" || name === "stubgen.exe"
    || name === "pylint.exe" || name === "codespell.exe" || name === "pybabel.exe"
    || name === "playwright.exe";
}

/** Decide whether a site-packages top-level entry (dir or file name) is dead
 * weight. Returns the matched rule for logging, or null. Nested rules
 * (containing "/") are handled by the caller via JW_VENV_SWEEP_NESTED. */
export function matchJwVenvSweep(name) {
  for (const rule of JW_VENV_SWEEP_RULES) {
    if (rule.match.includes("/")) continue; // nested rules handled separately
    if (name === rule.match) return rule;
    if (rule.distInfo) {
      // "<match>-<version>.dist-info" where the version starts with a digit —
      // "uvicorn-0.53.0.dist-info" must NOT match the "uv" rule. The stem
      // compare is case-insensitive because a wheel's dist-info name follows the
      // PROJECT name, not the import name, and the two need not agree in case.
      // This is defensive. Wheel naming is not stable enough to rely on: the rule
      // that was removed as unsafe (babel) had its dist-info spelled with a
      // capital B in the comment that justified it ("Babel-2.17.0.dist-info")
      // while the wheel actually installed in the JW venv today is lowercase
      // "babel-2.18.0.dist-info". No dist-info in the current venv starts with an
      // uppercase letter, so no remaining rule needs the case folding — kept
      // because a future one should not have to rediscover this.
      const m = /^(.+)-\d.*\.dist-info$/.exec(name);
      if (m && m[1].toLowerCase() === rule.match.toLowerCase()) return rule;
    }
  }
  return null;
}

// The api-deployed @openai/codex SDK resolves its native binaries lazily at
// Codex construction time (dist/index.js:448-460), so removing the vendored
// toolchain (~437 MB) is import-safe: the api starts fine; a codex specialist
// run errors at use time. The JS SDK itself stays.
//
// The vendor dir has no single fixed address in the flattened payload, so it is
// enumerated instead of hardcoded. All three shapes below are reachable,
// depending on which version assemble-backend.mjs picks as a multi-version
// package's "primary":
//   @openai/codex/vendor                              — the platform package
//       won primary. Its package.json name really is "@openai/codex", because
//       pnpm installs it through an npm alias
//       ("@openai/codex-win32-x64": "npm:@openai/codex@0.162.1-win32-x64"):
//       the alias dir name is not the package name.
//   @openai/codex/node_modules/@openai/codex/vendor   — the JS wrapper won
//       primary and the platform package nested underneath it. This is what
//       release5 actually shipped: release5-assemble.log:7 reports
//       "multi-version packages (nested under consumers): @openai/codex" and
//       :11 the sweep firing on exactly this path.
//   @openai/codex-<platform>/vendor                   — an alias dir that kept
//       its own name through flattening.
// Primary is "most consumers wins, ties to first seen" (assemble-backend.mjs:307
// -323), i.e. an artefact of readdir order over .pnpm — and here all seven
// versions have exactly ONE consumer each, so the tie-break IS the whole
// decision. A fourth shape follows from a platform package winning that tie:
//   @openai/codex-sdk/node_modules/@openai/codex/node_modules/@openai/codex/vendor
// (wrapper nested under the SDK, platform packages under the wrapper).
// Sweeping only the shape that happens to appear today makes the 437 MB win a
// coin flip on that ordering; enumerating every @openai scope in the tree,
// gated on the name only when collecting, makes it deterministic. See
// codexPackageDirs for the measurement.

// Bounds how many node_modules/@openai levels the walk descends, so a
// symlinked or self-nesting tree cannot spin. Two copies of one package nested
// under each other is already one level deeper than pnpm emits (the wrapper
// under the SDK under the wrapper is the deepest real shape, two descents);
// the bound is 4 so a cycle gets cut rather than walked.
const MAX_CODEX_NESTING = 4;

// The plain "codex" wrapper plus the six platform packages it optionally
// depends on ("codex-win32-x64", "codex-linux-arm64", ...). Deliberately NOT
// "@openai/codex-sdk": that is the JS SDK the api imports, so it stays in the
// payload — only the vendored native toolchain goes. A bare "codex-" prefix
// rule would take the SDK with it, and today that is saved only by the SDK
// happening to ship no vendor dir. Enumerate the real suffixes instead.
const CODEX_SWEEP_DIR = /^codex(?:-(?:darwin|linux|win32)-(?:x64|arm64))?$/;

/** Every @openai/codex* package dir under a node_modules root, including the
 * copies nested under ANY consumer — not only under another codex dir. Deduped
 * by realpath (a junction and its target are one package), depth-bounded, and
 * silent when the scope is absent — this is a sweep backstop, so nothing to
 * sweep is not an error.
 *
 * The descent is deliberately NOT gated on CODEX_SWEEP_DIR; that gate is what
 * the previous version of this walk still got wrong. pnpm installs the six
 * platform packages through npm aliases
 * ("@openai/codex-win32-x64": "npm:@openai/codex@0.162.1-win32-x64"), so their
 * package.json name is ALSO "@openai/codex" and all seven land under one
 * realDirs key with seven versions. assemble-backend.mjs's primaryOf then picks
 * "most consumers wins, ties to first seen" over a readdir order — and every
 * one of the seven has exactly one consumer, so the pick is that order. When a
 * PLATFORM package wins, the JS wrapper is no longer primary and gets nested
 * under its own consumer, which is the SDK:
 *   @openai/codex-sdk/node_modules/@openai/codex/node_modules/@openai/codex/vendor
 * "codex-sdk" does not match CODEX_SWEEP_DIR (it is the SDK services/api
 * imports, so it must stay), and a gated walk therefore never entered its
 * node_modules — the whole subtree was invisible and shipped. Measured by
 * replaying assemble-backend.mjs's real primaryOf/locations fixed point over
 * pnpm-lock.yaml:2994-3023 in both orders and materialising each result as a
 * throwaway tree (logs/f4-ab-distinct.mjs):
 *   wrapper-primary (the ordering release5 shipped) → 7 location entries
 *     resolving to 2 DISTINCT dirs; the gated walk found 2 of 2, which is
 *     exactly why the gap survived that build;
 *   platform-primary → 7 location entries resolving to 3 DISTINCT dirs; the
 *     gated walk found 1 of 3 and shipped the other two vendors
 *     (@openai/codex-sdk/node_modules/@openai/codex/vendor and one level
 *     deeper). Count the DISTINCT dirs, not the entries: five of the seven
 *     non-primary platform versions map to the same string, so a denominator of
 *     7 overstates both the miss and the find.
 * The name filter now decides only what gets COLLECTED; every @openai-scoped
 * dir is descended into. */
function codexPackageDirs(nmRoot) {
  const found = [];
  const seen = new Set();
  const visit = (scopeDir, depth) => {
    if (depth > MAX_CODEX_NESTING) return;
    let entries;
    try {
      entries = readdirSync(scopeDir, { withFileTypes: true });
    } catch {
      return; // no @openai scope here — nothing to sweep
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const dir = join(scopeDir, entry.name);
      let real;
      try {
        real = realpathSync(dir);
      } catch {
        continue; // broken link
      }
      if (seen.has(real)) continue;
      seen.add(real);
      // Descend BEFORE the name test: the interesting copies live under
      // packages whose own names are not sweep targets.
      visit(join(dir, "node_modules", "@openai"), depth + 1);
      if (!CODEX_SWEEP_DIR.test(entry.name)) continue;
      found.push(dir);
    }
  };
  visit(join(nmRoot, "@openai"), 0);
  return found;
}

/** Vendored native toolchains actually present under a node_modules root.
 * Returns [] when there are none, so callers loop unconditionally. */
export function codexVendorDirs(nmRoot) {
  return codexPackageDirs(nmRoot)
    .map((dir) => join(dir, "vendor"))
    .filter((vendor) => existsSync(vendor));
}

// ---------------------------------------------------------------------------
// Post-sweep verification for the codex vendor sweep above.
//
// codexVendorDirs DELETES; this function checks that the deletion happened. The
// two must not share a name rule, or the check is circular: when CODEX_SWEEP_DIR
// stops matching — a renamed alias dir, a flattener layout change — the sweep
// silently deletes nothing AND the verification silently finds nothing, so the
// 437 MB win vanishes with every gate still green. That is review finding F12,
// and F4 is the instance that makes it concrete: the original sweep targeted a
// path that could not exist in the flattened payload, and only a human reading
// the code noticed.
//
// So this one matches on CONTENT, not on any package or directory name: a
// vendored codex toolchain is the only thing in the tree that ships
// `codex-package.json`. Measured across the pnpm store on this machine, that
// file appears exactly once (@openai/codex-win32-x64 .../vendor/
// x86_64-pc-windows-msvc/codex-package.json) and ZERO times under @openai/
// codex-sdk, so the SDK the api imports can never be mistaken for a leftover.
// A directory simply named `vendor` is NOT evidence — typescript ships one too,
// and a name-based check would either flag it or need to relearn which names to
// trust, which is the circularity this avoids.
//
// Deliberately a full walk rather than a re-derivation of the sweep's own
// candidates: it has to find vendor dirs the sweep's enumeration NEVER VISITED,
// which is precisely the F4 failure mode. The payload node_modules is ~870
// directories (measured), so the walk is cheap next to the flatten that built
// it.
export const CODEX_VENDOR_MARKER = "codex-package.json";

/** Vendored codex toolchains still present under a node_modules root, found by
 * content marker. Returns [] when the sweep did its job. Depth-bounded so a
 * self-nesting or symlinked tree cannot spin. */
export function leftoverCodexVendorDirs(nmRoot, maxDepth = 12) {
  const found = [];
  const seen = new Set();

  /** Nearest ancestor directory named "vendor", or null. */
  const vendorAncestor = (dir) => {
    let cur = dir;
    for (let guard = 0; guard < 8; guard += 1) {
      const parent = dirname(cur);
      if (parent === cur) return null;
      if (basename(parent) === "vendor") return parent;
      cur = parent;
    }
    return null;
  };

  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable or a symlink loop — nothing to verify here
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile()) {
        if (entry.name !== CODEX_VENDOR_MARKER) continue;
        const vendor = vendorAncestor(dir);
        if (!vendor) continue; // marker outside a vendor dir: not a toolchain
        let real;
        try {
          real = realpathSync(vendor);
        } catch {
          continue;
        }
        if (seen.has(real)) continue;
        seen.add(real);
        found.push(vendor);
        continue;
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) visit(full, depth + 1);
    }
  };

  visit(nmRoot, 0);
  return found.sort();
}
