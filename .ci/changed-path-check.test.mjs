import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTest } from "../test/support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"] });

function run(paths, enforce, extraEnv = {}, cwd = process.cwd()) {
  return spawnSync(process.execPath, [resolve(".ci/changed-path-check.mjs"), ...paths], {
    cwd, env: { ...process.env, CI_ENFORCE_SOURCE_MAP: enforce ? "1" : "0", CI_FETCH_PUSH_BASE: "0", CI_FORK_UPSTREAM: "", ...extraEnv }, encoding: "utf8",
  });
}

test("changed-path policy accepts a mapped source and warns during the migration window", () => {
  const mapped = run(["apps/web/src/MemoryGraphCanvas.tsx"], true);
  assert.equal(mapped.status, 0, mapped.stderr);
  const warning = run(["apps/web/src/NewRiskyPanel.tsx"], false);
  assert.equal(warning.status, 0, warning.stderr);
  assert.match(`${warning.stdout}\n${warning.stderr}`, /warning|0\/1 mapped/);
});

test("changed-path policy blocks an unmapped high-risk source after enforcement", () => {
  const result = run(["apps/web/src/NewRiskyPanel.tsx"], true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no test mapping/);
});

test("changed-path enforcement uses source content for additions", t => {
  const cwd = mkdtempSync(join(tmpdir(), "changed-path-classification-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "apps/web/src"), { recursive: true });
  mkdirSync(join(cwd, "test"));
  writeFileSync(join(cwd, "test/source-test-map.json"), '{"version":1,"entries":[]}');
  const declarations = "apps/web/src/capabilities.ts";
  const barrel = "apps/web/src/index.ts";
  writeFileSync(join(cwd, declarations), 'import type { Name } from "./name.js"; export interface Capability { name: Name }');
  writeFileSync(join(cwd, barrel), 'export { createPanel } from "./panel.js";');
  const structural = run([declarations, barrel], true, {}, cwd);
  assert.equal(structural.status, 0, structural.stderr);
  assert.match(structural.stderr, /policy warning/);
  assert.ok(structural.stderr.includes(declarations));
  assert.ok(structural.stderr.includes(barrel));

  writeFileSync(join(cwd, barrel), 'export const panel = createPanel();');
  const behavior = run([declarations, barrel], true, {}, cwd);
  assert.equal(behavior.status, 1);
  const [warnings, failures] = behavior.stderr.split("policy failed:");
  assert.ok(warnings.includes(declarations) && !warnings.includes(barrel));
  assert.ok(failures.includes(barrel) && !failures.includes(declarations));
});

test("changed-path policy can compare a CI base and head revision", t => {
  const cwd = mkdtempSync(join(tmpdir(), "changed-path-policy-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=CI Test", "-c", "user.email=ci@example.test", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const source = "apps/web/src/Graph.tsx";
  mkdirSync(join(cwd, "apps/web/src"), { recursive: true });
  mkdirSync(join(cwd, "test"));
  writeFileSync(join(cwd, "test/source-test-map.json"), JSON.stringify({ version: 1, entries: [{ source }] }));
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(cwd, source), "export const graph = true;\n");
  git("add", ".");
  git("commit", "-qm", "mapped source");
  const mapped = run([], true, { CI_BASE_SHA: base, CI_HEAD_SHA: git("rev-parse", "HEAD") }, cwd);
  assert.equal(mapped.status, 0, mapped.stderr);
  assert.match(mapped.stdout, /1\/1 mapped/);
  const unmappedPath = "services/runner/src/New Runner.ts";
  mkdirSync(join(cwd, "services/runner/src"), { recursive: true });
  writeFileSync(join(cwd, unmappedPath), "export const unmapped = true;\n");
  git("add", ".");
  git("commit", "-qm", "unmapped source");
  const unmapped = run([], true, { CI_BASE_SHA: base, CI_HEAD_SHA: git("rev-parse", "HEAD") }, cwd);
  assert.equal(unmapped.status, 1);
  assert.ok(unmapped.stderr.includes(`added source has no test mapping: ${unmappedPath}`));

  const legacyBase = git("rev-parse", "HEAD");
  writeFileSync(join(cwd, unmappedPath), "export const unmapped = false;\n");
  git("commit", "-qam", "modify existing unmapped source");
  const modified = run([], true, { CI_BASE_SHA: legacyBase, CI_HEAD_SHA: git("rev-parse", "HEAD") }, cwd);
  assert.equal(modified.status, 0, modified.stderr);
  assert.ok(modified.stderr.includes(`existing changed source has no test mapping: ${unmappedPath}`));

  git("rm", unmappedPath);
  git("commit", "-qm", "delete existing unmapped source");
  const deleted = run([], true, { CI_BASE_SHA: legacyBase, CI_HEAD_SHA: git("rev-parse", "HEAD") }, cwd);
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.equal(deleted.stderr, "");
});


test("changed-path policy reports missing ranges without claiming it mapped paths", () => {
  for (const base of ["", "0".repeat(40)]) {
    const result = run([], true, { CI_BASE_SHA: base, CI_HEAD_SHA: "a".repeat(40) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not applicable: no comparison range/);
    assert.doesNotMatch(result.stdout, /mapped/);
  }
});

test("changed-path policy fetches an amended push's missing previous tip", t => {
  const cwd = mkdtempSync(join(tmpdir(), "changed-path-forced-push-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const remote = join(cwd, "remote");
  const checkout = join(cwd, "checkout");
  const git = (repo, ...args) => execFileSync("git", ["-C", repo, "-c", "user.name=CI Test", "-c", "user.email=ci@example.test", ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const source = "apps/web/src/Graph.tsx";
  mkdirSync(join(remote, "apps/web/src"), { recursive: true });
  mkdirSync(join(remote, "test"));
  writeFileSync(join(remote, "test/source-test-map.json"), JSON.stringify({ version: 1, entries: [{ source }] }));
  git(remote, "init", "-q");
  git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(remote, "add", ".");
  git(remote, "commit", "-qm", "base");
  // Comparing against the new tip's parent would incorrectly flag this file.
  writeFileSync(join(remote, "apps/web/src/Unchanged.tsx"), "export const unchanged = true;\n");
  git(remote, "add", ".");
  git(remote, "commit", "-qm", "original push");
  const base = git(remote, "rev-parse", "HEAD");
  writeFileSync(join(remote, source), "export const graph = true;\n");
  git(remote, "add", ".");
  git(remote, "commit", "--amend", "--no-edit", "-q");
  const head = git(remote, "rev-parse", "HEAD");
  git(cwd, "clone", "--no-local", "-q", remote, checkout);

  const env = { CI_BASE_SHA: base, CI_HEAD_SHA: head };
  const missing = run([], true, env, checkout);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Unable to compare/);
  const fetched = run([], true, { ...env, CI_FETCH_PUSH_BASE: "1" }, checkout);
  assert.equal(fetched.status, 0, fetched.stderr);
  assert.match(fetched.stdout, new RegExp(`Fetching previous push tip ${base}`));
  assert.match(fetched.stdout, /1\/1 mapped/);
});

test("changed-path policy checks the fork contribution after a rebase onto upstream", t => {
  const cwd = mkdtempSync(join(tmpdir(), "changed-path-fork-rebase-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const upstream = join(cwd, "upstream");
  const fork = join(cwd, "fork");
  const git = (repo, ...args) => execFileSync("git", ["-C", repo, "-c", "user.name=CI Test", "-c", "user.email=ci@example.test", ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const source = "apps/web/src/Graph.tsx";
  const upstreamSource = "apps/web/src/Upstream.tsx";
  const forkSource = "apps/web/src/Fork.tsx";
  mkdirSync(join(upstream, "apps/web/src"), { recursive: true });
  mkdirSync(join(upstream, "test"));
  writeFileSync(join(upstream, "test/source-test-map.json"), JSON.stringify({ version: 1, entries: [{ source }] }));
  writeFileSync(join(upstream, source), "export const graph = false;\n");
  git(upstream, "init", "-q", "-b", "main");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "common base");
  git(cwd, "clone", "-q", upstream, fork);
  writeFileSync(join(fork, source), "export const graph = true;\n");
  git(fork, "commit", "-qam", "fork contribution");
  const previousTip = git(fork, "rev-parse", "HEAD");

  writeFileSync(join(upstream, upstreamSource), "export const upstream = true;\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "upstream advance");
  const rebaseBase = git(upstream, "rev-parse", "HEAD");
  git(fork, "pull", "--rebase", "origin", "main");
  const rebasedTip = git(fork, "rev-parse", "HEAD");
  // Upstream can advance again while the fork's rebased push is in flight.
  writeFileSync(join(upstream, upstreamSource), "export const upstream = false;\n");
  git(upstream, "commit", "-qam", "later upstream advance");

  const env = { CI_BASE_SHA: previousTip, CI_HEAD_SHA: rebasedTip, CI_FETCH_PUSH_BASE: "1" };
  const beforeAfter = run([], true, env, fork);
  assert.equal(beforeAfter.status, 1);
  assert.ok(beforeAfter.stderr.includes(upstreamSource));

  const forkEnv = { ...env, CI_FORK_UPSTREAM: upstream };
  const rebased = run([], true, forkEnv, fork);
  assert.equal(rebased.status, 0, rebased.stderr);
  assert.ok(rebased.stdout.includes(`upstream merge base ${rebaseBase}`));
  assert.match(rebased.stdout, /1\/1 mapped/);

  writeFileSync(join(fork, forkSource), "export const forkOnly = true;\n");
  git(fork, "add", ".");
  git(fork, "commit", "--amend", "--no-edit", "-q");
  const blocked = run([], true, { ...forkEnv, CI_HEAD_SHA: git(fork, "rev-parse", "HEAD") }, fork);
  assert.equal(blocked.status, 1);
  assert.ok(blocked.stderr.includes(forkSource));
  assert.ok(!blocked.stderr.includes(upstreamSource));
});
