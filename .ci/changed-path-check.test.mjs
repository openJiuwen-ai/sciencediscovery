import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTest } from "../test/support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"] });

function run(paths, enforce, extraEnv = {}, cwd = process.cwd()) {
  return spawnSync(process.execPath, [resolve(".ci/changed-path-check.mjs"), ...paths], {
    cwd, env: { ...process.env, CI_ENFORCE_SOURCE_MAP: enforce ? "1" : "0", ...extraEnv }, encoding: "utf8",
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
  writeFileSync(join(cwd, "apps/web/src/Unmapped.tsx"), "export const unmapped = true;\n");
  git("add", ".");
  git("commit", "-qm", "unmapped source");
  const unmapped = run([], true, { CI_BASE_SHA: base, CI_HEAD_SHA: git("rev-parse", "HEAD") }, cwd);
  assert.equal(unmapped.status, 1);
  assert.match(unmapped.stderr, /no test mapping: apps\/web\/src\/Unmapped.tsx/);
});
