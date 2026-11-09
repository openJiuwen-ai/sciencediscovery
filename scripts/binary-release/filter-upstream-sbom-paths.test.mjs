import { createTest } from "../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { hasUnapprovedHomePath } from "./filter-upstream-sbom-paths.mjs";

const file = "memory-graph/site-packages/pydantic_core-2.46.4.dist-info/sboms/pydantic-core.cyclonedx.json";
const ref = "path+file:///home/runner/work/pydantic/pydantic/pydantic-core#2.46.4";
const leaks = (path, value) => hasUnapprovedHomePath(path, JSON.stringify(value), "/home/runner");

test("permits only known supplier reference prefixes in their corresponding SBOMs", () => {
  assert.equal(leaks(file, { "bom-ref": ref, dependencies: [{ ref }] }), false);
  assert.equal(leaks("memory-graph/site-packages/watchfiles-1.2.0.dist-info/sboms/watchfiles_rust_notify.cyclonedx.json",
    { ref: "path+file:///home/runner/work/watchfiles/watchfiles#watchfiles_rust_notify@1.2.0" }), false);
});

test("keeps scanning other fields, other files and unexpected paths", () => {
  for (const value of [
    { ref, private: "/home/runner/private/key" },
    { description: ref },
    { ref: ref + " /home/runner/private/key" },
    { ref: "path+file:///home/runner/work/other/repo#1" },
    { ref: "path+file:///home/runner/work/pydantic/pydantic/pydantic-core-extra#1" },
  ]) assert.equal(leaks(file, value), true);
  assert.equal(leaks("memory-graph/site-packages/other.json", { ref }), true);
  assert.equal(hasUnapprovedHomePath(file, '{"ref": "' + ref, "/home/runner"), true);
});

test("private build roots inside otherwise allowed metadata remain failures", () => {
  for (const path of ["/home/runner/work/sciencediscovery/sciencediscovery",
    "/home/runner/private/staging", "/home/runner/private/output"]) {
    assert.equal(leaks(file, { ref, build: path }), true);
  }
  assert.equal(hasUnapprovedHomePath("app/code.js", '"/roots/list_changed"', "/root"), false);
  assert.equal(hasUnapprovedHomePath("app/code.js", '"/root/private"', "/root"), true);
});

test("the complete payload gate still rejects exact build roots even in approved references", () => {
  const root = mkdtempSync(join(tmpdir(), "sbom-scan-test-"));
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const source = readFileSync(join(repository, "scripts/binary-release/build-payload.sh"), "utf8");
  // Exercise the production function with the CI HOME needle, without changing HOME.
  const start = source.indexOf("assert_no_build_paths() {");
  const fn = source.slice(start, source.indexOf("\n}\n", start) + 3)
    .replace('"${HOME:-}"', '"/home/runner"').replace('"${USERPROFILE:-}"', '""');
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  const run = (shared) => spawnSync("bash", ["-c",
    `set -euo pipefail\nrepository_root=$1\nshared_dir=$2\noutput=$3\n${fn}\nassert_no_build_paths "$3"`,
    "test", repository, shared, root], { encoding: "utf8" });
  try {
    writeFileSync(target, JSON.stringify({ ref }));
    const before = readFileSync(target, "utf8");
    assert.equal(run(join(root, "stage")).status, 0);
    assert.equal(readFileSync(target, "utf8"), before, "SBOM bytes must not change");
    assert.notEqual(run("/home/runner/work/pydantic/pydantic").status, 0);
    writeFileSync(target, JSON.stringify({ ref, private: "/home/runner/private/key" }));
    assert.notEqual(run(join(root, "stage")).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** #1006's acceptance case: a payload whose only `/home/runner` hits are the two
 *  approved SBOM references must pass *both* checks — the payload scan above and
 *  the assembled-artifact scan here. Drives the real function out of
 *  `package-binary-release.sh` so a later edit cannot quietly drop either half.
 *
 *  The needles are fixed build paths rather than this checkout's own: they are
 *  what the gate compares against, and a host path can carry a drive letter or a
 *  space the shell escaping is not written for. */
test("the assembled-artifact gate passes approved SBOM references and still fails real build roots", () => {
  const root = mkdtempSync(join(tmpdir(), "release-scan-test-"));
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const source = readFileSync(join(repository, "scripts/package-binary-release.sh"), "utf8");
  const start = source.indexOf("assert_no_release_build_paths() {");
  assert.notEqual(start, -1, "package-binary-release.sh must define the final-artifact gate");
  const fn = source.slice(start, source.indexOf("\n}\n", start) + 3);
  // Written to its own script rather than inlined into `bash -c`, so the
  // function's own sed escaping reaches sed exactly as it does in production.
  const gate = join(root, "gate.sh");
  writeFileSync(gate, [
    "set -euo pipefail",
    "repository_root=/build/sciencediscovery",
    "output_dir=/build/out",
    fn,
    'assert_no_release_build_paths "$1"',
    "",
  ].join("\n"));
  const artifact = join(root, "ScienceDiscovery-linux-x86_64").replace(/\\/g, "/");
  const run = () => spawnSync("bash", [gate.replace(/\\/g, "/"), artifact], { encoding: "utf8" });
  const scan = (contents) => { writeFileSync(artifact, contents); return run(); };
  try {
    // Both approved upstream SBOM regions, plus bytes that name no machine.
    assert.equal(scan([
      `{"ref":"${ref}","dependencies":[{"ref":"${ref}"}]}`,
      '{"ref":"path+file:///home/runner/work/watchfiles/watchfiles#watchfiles_rust_notify@1.2.0"}',
      '"/roots/list_changed"',
    ].join("\n")).status, 0, "approved SBOM references must not fail the final gate");
    assert.equal(scan("no build paths here").status, 0);

    // A path unique to this build is still a leak at this level.
    assert.notEqual(scan("#!/bin/sh: /build/sciencediscovery/node_modules").status, 0,
      "the repository root must fail");
    assert.notEqual(scan("/build/out/.payload-x86_64").status, 0, "the output directory must fail");

    // The coverage this change removes, stated as a test: the final artifact is
    // no longer scanned for HOME at all, so a private /home/runner path passes
    // here and is caught only by the payload scan above.
    assert.equal(scan('{"private":"/home/runner/private/key"}').status, 0,
      "HOME is deliberately not scanned on the assembled artifact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
