// #1218: a stale jw venv must be refused at the start of `assemble`, before the
// payload is written — not after the whole backend tree, venv templates,
// micromamba and bytecode have been copied.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseDistributionSnapshot, parseUvLockVersions, venvLockSkew, venvPreflightFailure, venvPreflightProblem,
} from "../scripts/lib/venv-lock-consistency.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "assemble-backend.mjs");

/** The shape the patched lock has: workspace header, then pinned packages. */
const LOCK = `version = 1
revision = 3
requires-python = ">=3.12"

[manifest]

[[package]]
name = "greenlet"
version = "3.5.5"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "openjiuwen"
version = "0.2.6"
source = { editable = "." }

[[package]]
name = "pywin32"
version = "311"
source = { registry = "https://pypi.org/simple" }
`;

test("parseUvLockVersions reads every pinned [[package]] entry and nothing else", () => {
  const pins = parseUvLockVersions(LOCK);
  assert.deepEqual([...pins.keys()].sort(), ["greenlet", "openjiuwen", "pywin32"]);
  assert.deepEqual([...pins.get("greenlet")], ["3.5.5"]);
});

test("venvLockSkew reports the stale installed version, not the pin", () => {
  const installed = parseDistributionSnapshot(JSON.stringify({ Greenlet: "3.5.0", "openjiuwen": "0.2.6" }));
  assert.deepEqual(venvLockSkew(LOCK, installed), [{ installed: "3.5.0", locked: ["3.5.5"], name: "greenlet" }]);
  // pywin32 is listed by the lock but absent from this venv (another platform):
  // the subset is not a mismatch, only an installed version that lags its pin is.
  assert.equal(venvLockSkew(LOCK, installed).length, 1);
});

test("names are compared across the hyphen/underscore/dot spellings in play", () => {
  // importlib.metadata reports `pydantic_core`; uv.lock writes `pydantic-core`.
  const lock = '[[package]]\nname = "pydantic-core"\nversion = "2.46.3"\n';
  const snapshot = parseDistributionSnapshot(JSON.stringify({ pydantic_core: "1.0.0" }));
  assert.deepEqual(venvLockSkew(lock, snapshot), [{ installed: "1.0.0", locked: ["2.46.3"], name: "pydantic-core" }]);
  // A matching version under the other spelling is not a skew.
  assert.equal(venvLockSkew(lock, parseDistributionSnapshot(JSON.stringify({ "Pydantic-Core": "2.46.3" }))).length, 0);
});

test("one name may be pinned once per resolution branch and either is accepted", () => {
  const lock = '[[package]]\nname = "numpy"\nversion = "2.4.6"\nresolution-markers = ["python_full_version < \'3.12\'"]\n'
    + '\n[[package]]\nname = "numpy"\nversion = "2.5.4"\nresolution-markers = ["python_full_version >= \'3.12\'"]\n';
  assert.equal(venvLockSkew(lock, parseDistributionSnapshot(JSON.stringify({ numpy: "2.5.4" }))).length, 0,
    "the branch the venv actually installed is accepted");
  assert.equal(venvLockSkew(lock, parseDistributionSnapshot(JSON.stringify({ numpy: "2.4.6" }))).length, 0);
  const stale = venvLockSkew(lock, parseDistributionSnapshot(JSON.stringify({ numpy: "2.0.0" })));
  assert.deepEqual(stale, [{ installed: "2.0.0", locked: ["2.4.6", "2.5.4"], name: "numpy" }]);
  assert.match(venvPreflightFailure(stale), /uv\.lock requires 2\.4\.6 or 2\.5\.4/u);
});

test("a venv that matches the patch set produces no refusal", () => {
  const installed = parseDistributionSnapshot(JSON.stringify({ greenlet: "3.5.5", openjiuwen: "0.2.6" }));
  assert.equal(venvPreflightProblem(LOCK, installed), null);
});

test("the refusal names both versions and the same repair command as the end gate", () => {
  const installed = parseDistributionSnapshot(JSON.stringify({ greenlet: "3.5.0" }));
  const message = venvPreflightFailure(venvLockSkew(LOCK, installed));
  assert.match(message, /jw venv preflight FAILED/u);
  assert.match(message, /greenlet 3\.5\.0 \(uv\.lock requires 3\.5\.5\)/u);
  assert.match(message, /node scripts\/jiuwenswarm\.mjs setup/u);
  assert.match(message, /bash scripts\/jiuwenswarm\.sh setup/u);
});

test("a long skew list is bounded instead of printing every package", () => {
  const problems = Array.from({ length: 8 }, (_, index) => ({ installed: "1.0.0", locked: ["2.0.0"], name: `pkg${index}` }));
  const message = venvPreflightFailure(problems);
  assert.match(message, /pkg0 1\.0\.0/u);
  assert.match(message, /and 3 more/u);
  assert.doesNotMatch(message, /pkg7/u);
});

test("the preflight runs before assemble writes anything", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const preflight = source.indexOf("venvPreflightProblem(");
  assert.ok(preflight > 0, "assemble must call the preflight");
  // Every payload-writing step must come after it; the earliest is `rm(out)`
  // (fresh staging), then the deploy that fills it, then the backend copy.
  for (const marker of ["await rm(out, { recursive: true, force: true });", "deploying prod closure", "copying backend static tree"]) {
    const at = source.indexOf(marker);
    assert.ok(at > 0, `marker not found: ${marker}`);
    assert.ok(preflight < at, `the preflight must run before: ${marker}`);
  }
});
