// Copy filter for the JiuwenSwarm src tree stage (assemble-backend stage 5).
// Extracted to lib (same pattern as venv-launchers.mjs) so the rules are
// unit-testable — every rule below encodes a shipped-installer incident.
import { relative } from "node:path";

// ".git"/"docs" must only match at the copy ROOT (the project's own
// docs folder). pyFilter([".git", "docs", ...]) matched every path segment
// and silently stripped lark_oapi/api/docs and cyclopts/docs out of the
// bundled .venv — lark_oapi then failed to import at all (circular-import
// error on `from . import docs`), which took the feishu channel down with a
// NameError (P2CardActionTrigger) and an endless 60s channel retry loop.
// __pycache__/.pyc/ruff.exe stay any-depth excludes (ruff.exe is the venv's
// dev tool at .venv/Scripts/ruff.exe; no site-package ships a ruff.exe).
// Field lesson: a `npm install` run inside
// jiuwenswarm/channels/web/frontend left a 329.5 MB node_modules in the
// build tree; no rule matched it, so it shipped whole (+326 MB payload,
// +71 MB installer). Frontend build deps have zero runtime value — exclude
// node_modules at ANY depth (a Python .venv never contains one).
export function makeJwSrcFilter(jwSrcIn) {
  return (src) => {
    const segs = relative(jwSrcIn, src).split(/[\\/]/).filter(Boolean);
    if (segs[segs.length - 1] === "ruff.exe") return false;
    if (segs.includes("node_modules")) return false;
    // .doc_project_maintainer is a docs-generation mirror with
    // >260-char paths (it broke the uninstaller once and PowerShell
    // enumeration) and zero runtime value — dead weight, exclude at the root.
    // Lesson: running the repo's pytest suite from src/ drops coverage
    // artifacts at the copy root (htmlcov/ alone measured 95 MB after
    // test-comparison runs and shipped in the installer, +59 MB
    // after 7z). Root-level only — the venv sits under .venv/ and is exempt.
    const rootExcludes = new Set([
      ".git", "docs", ".doc_project_maintainer",
      "htmlcov", "coverage.xml", ".coverage", ".pytest_cache",
    ]);
    if (rootExcludes.has(segs[0])) return false;
    // Lesson: test-comparison runs left ~19 MB of test
    // bytecode under tests/**/__pycache__ that shipped in the installer. The
    // jiuwenswarm source tree keeps its __pycache__ (it ships precompiled
    // bytecode); only the test tree's caches are dead weight.
    if (segs[0] === "tests" && segs.includes("__pycache__")) return false;
    return true;
  };
}
