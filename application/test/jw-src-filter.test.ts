// Field lesson: `npm install` inside
// jiuwenswarm/channels/web/frontend left a 329.5 MB node_modules in the
// build tree; the src-copy filter had no node_modules rule, so it shipped
// whole (+326 MB payload, +71 MB installer). These tests pin every filter
// rule, each of which encodes a shipped-installer incident.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeJwSrcFilter } from "../scripts/lib/jw-src-filter.mjs";

const ROOT = "E:\\jw\\src";
const keep = makeJwSrcFilter(ROOT);

const allows = (rel: string) => keep(join(ROOT, rel));
const denies = (rel: string) => !keep(join(ROOT, rel));

test("regular source files pass", () => {
  assert.equal(allows("jiuwenswarm\\channels\\web\\gateway.py"), true);
  assert.equal(allows("jiuwenswarm\\agents\\runner.py"), true);
  assert.equal(allows(".venv\\Lib\\site-packages\\lark_oapi\\api\\docs\\__init__.py"), true);
  assert.equal(allows(".venv\\Scripts\\python.exe"), true);
});

test("node_modules is excluded at ANY depth", () => {
  assert.equal(denies("jiuwenswarm\\channels\\web\\frontend\\node_modules"), true);
  assert.equal(denies("jiuwenswarm\\channels\\web\\frontend\\node_modules\\react\\index.js"), true);
  assert.equal(denies("jiuwenswarm\\channels\\web\\frontend\\node_modules\\.vite\\deps.js"), true);
  assert.equal(denies("node_modules\\somepkg\\lib.js"), true);
});

test("ruff.exe stays excluded at any depth (venv dev tool)", () => {
  assert.equal(denies(".venv\\Scripts\\ruff.exe"), true);
  assert.equal(denies("tools\\ruff.exe"), true);
});

test("root-level docs/.git/coverage excludes", () => {
  assert.equal(denies("docs"), true);
  assert.equal(denies("docs\\guide.md"), true);
  assert.equal(denies(".git\\objects\\pack"), true);
  assert.equal(denies(".doc_project_maintainer"), true);
  assert.equal(denies("htmlcov\\index.html"), true);
  assert.equal(denies("coverage.xml"), true);
  assert.equal(denies(".coverage"), true);
  assert.equal(denies(".pytest_cache\\v\\cache"), true);
});

test("deep 'docs' directories inside the venv survive (regression)", () => {
  // lark_oapi/api/docs and cyclopts/docs are real site-packages subpackages —
  // stripping them took the feishu channel down with a NameError.
  assert.equal(allows(".venv\\Lib\\site-packages\\lark_oapi\\api\\docs\\base.py"), true);
  assert.equal(allows(".venv\\Lib\\site-packages\\cyclopts\\docs"), true);
  // The project's own docs/ (root level) is still excluded — covered above.
});

test("tests/**/__pycache__ excluded, source __pycache__ kept", () => {
  assert.equal(denies("tests\\unit\\__pycache__\\test_x.cpython-312.pyc"), true);
  assert.equal(allows("jiuwenswarm\\channels\\web\\__pycache__\\gateway.cpython-312.pyc"), true);
});

test("relative path separators are normalized (forward slashes from fs.cp on any host)", () => {
  assert.equal(keep(join(ROOT, "jiuwenswarm/channels/web/frontend/node_modules/react/index.js")), false);
  assert.equal(keep(join(ROOT, ".venv/Lib/site-packages/lark_oapi/api/docs/base.py")), true);
});
