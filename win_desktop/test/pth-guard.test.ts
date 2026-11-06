// Pins the payload .pth guard (scripts/lib/pth-guard.mjs). The regression that
// motivated the content-based match: the guard used to fail only for
// `_editable_impl_*.pth`, so a plain `<name>.pth` from the standalone
// idea-tree project that still pointed at a previous checkout was copied into
// envs-template untouched and shipped — the payload smoke import could not see
// it because it sets PYTHONPATH to the shipped sources instead of importing
// through the venv's site-packages. The shape depended on which convention
// wrote the file, which is exactly what a filename check cannot decide.
import test from "node:test";
import assert from "node:assert/strict";

import { rewritePthText, SD_BACKEND_PLACEHOLDER } from "../scripts/lib/pth-guard.mjs";

const repo = "C:\\work\\sciencediscovery";

test("an editable finder entry under the repo becomes the runtime placeholder", () => {
  const { lines, placeholdered, outside } = rewritePthText({
    text: `${repo}\\services\\api\\src\n`,
    repo,
  });
  assert.deepEqual(outside, []);
  assert.equal(placeholdered, true);
  assert.deepEqual(lines, [`${SD_BACKEND_PLACEHOLDER}\\services\\api\\src`]);
});

test("the plain <name>.pth convention is rewritten the same way", () => {
  const { lines, placeholdered, outside } = rewritePthText({
    text: `${repo}\\services\\idea-tree\\src\n`,
    repo,
  });
  assert.deepEqual(outside, []);
  assert.equal(placeholdered, true);
  assert.deepEqual(lines, [`${SD_BACKEND_PLACEHOLDER}\\services\\idea-tree\\src`]);
});

test("a plain .pth pointing at another checkout is reported, not shipped", () => {
  const stale = "C:\\Users\\someone\\old-checkout\\services\\idea-tree\\src";
  const { lines, placeholdered, outside } = rewritePthText({
    text: `${stale}\n`,
    repo,
  });
  assert.deepEqual(outside, [stale]);
  assert.equal(placeholdered, false);
  // The caller fails the build on `outside`; the entry is not rewritten into a
  // placeholder that would resolve against the new payload root.
  assert.deepEqual(lines, [stale]);
});

test("import-style shims and relative entries are kept and not reported", () => {
  const shims = [
    "import sys; sys.path.remove('')",
    "import __editable___sciencediscovery_gateway_finder; __editable___sciencediscovery_gateway_finder.install()",
    ".",
    "..\\sibling",
  ];
  for (const shim of shims) {
    const { lines, placeholdered, outside } = rewritePthText({ text: `${shim}\n`, repo });
    assert.deepEqual(outside, [], shim);
    assert.equal(placeholdered, false, shim);
    assert.deepEqual(lines, [shim]);
  }
});

test("forward slashes and drive-letter case still match the repo prefix", () => {
  const { lines, placeholdered, outside } = rewritePthText({
    text: "c:/Work/ScienceDiscovery/services/idea-tree/src\n",
    repo,
  });
  assert.deepEqual(outside, []);
  assert.equal(placeholdered, true);
  assert.deepEqual(lines, [`${SD_BACKEND_PLACEHOLDER}\\services\\idea-tree\\src`]);
});

test("a sibling directory that only shares the prefix is outside the repo", () => {
  const sibling = `${repo}-other\\services\\idea-tree\\src`;
  const { outside, placeholdered } = rewritePthText({ text: `${sibling}\n`, repo });
  assert.deepEqual(outside, [sibling]);
  assert.equal(placeholdered, false);
});

test("a file with several entries rewrites only the ones under the repo", () => {
  const stale = "D:\\old\\checkout\\src";
  const { lines, placeholdered, outside } = rewritePthText({
    text: `# comment\n\n${repo}\\a\n${stale}\n`,
    repo,
  });
  assert.deepEqual(outside, [stale]);
  assert.equal(placeholdered, true);
  assert.deepEqual(lines, [`${SD_BACKEND_PLACEHOLDER}\\a`, stale]);
});

test("comments and blank lines alone leave nothing to write", () => {
  const { lines, placeholdered, outside } = rewritePthText({ text: "# nothing\n\n", repo });
  assert.deepEqual(lines, []);
  assert.deepEqual(outside, []);
  assert.equal(placeholdered, false);
});
