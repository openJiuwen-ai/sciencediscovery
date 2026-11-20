// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkVersionChange,
  RELEASE_METADATA,
  SEMVER,
  VERSION_FILE,
  versionOf,
} from "./check-release-version.mjs";

const TITLE = "chore(release): retag the Windows desktop package as 0.4.0.rc1";
const ALL_METADATA = [...RELEASE_METADATA, VERSION_FILE];

function verdict(over = {}) {
  return checkVersionChange({
    baseVersion: "0.4.1",
    changedPaths: ALL_METADATA,
    headVersion: "0.4.0-rc1",
    title: TITLE,
    ...over,
  });
}

test("a pull request that leaves the version alone is never blocked", () => {
  assert.equal(verdict({ changedPaths: ["apps/desktop/src/App.tsx"], headVersion: "0.4.1" }).ok, true);
  // Even with a functional title and none of the metadata: nothing moved.
  assert.equal(verdict({ changedPaths: [], headVersion: "0.4.1", title: "fix(mcp): reconnect" }).ok, true);
});

test("a release change moves the version with every place it is spelled", () => {
  const result = verdict();
  assert.equal(result.ok, true);
  assert.match(result.reason, /0\.4\.1 -> 0\.4\.0-rc1/u);
});

test("a functional change that bumps the version is rejected, like #1197 was", () => {
  // The exact shape of the PR that caused this: one line of package.json, an
  // unrelated title, no release metadata.
  const result = verdict({ changedPaths: [VERSION_FILE], title: "fix(mcp): repair backend discovery" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not start with "chore\(release\):"/u);
  assert.match(result.reason, /does not update application\/electron-builder\.yml/u);
});

test("the title alone is not enough", () => {
  const result = verdict({ changedPaths: [VERSION_FILE] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /it does not update/u);
  assert.match(result.reason, /README_zh\.md/u);
});

test("the file set alone is not enough", () => {
  const result = verdict({ title: "fix(desktop): polish the dialog" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not start with "chore\(release\):"/u);
});

test("the release prefix has to start the title", () => {
  assert.equal(verdict({ title: "fix: chore(release): sneak it in" }).ok, false);
  assert.equal(verdict({ title: "  chore(release): leading space is fine" }).ok, true);
});

test("one missing metadata file is named, not just counted", () => {
  const missing = "README_zh.md";
  const result = verdict({ changedPaths: ALL_METADATA.filter((path) => path !== missing) });
  assert.equal(result.ok, false);
  assert.match(result.reason, new RegExp(`does not update ${missing}`, "u"));
});

test("the dot spelling is rejected with the spelling to use instead", () => {
  // 0.4.0.rc1 shipped once and is not a SemVer version; electron-updater could
  // not have compared it.
  const result = verdict({ headVersion: "0.4.0.rc1" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a SemVer version/u);
  assert.match(result.reason, /"0\.4\.0-rc1"/u);
});

test("SemVer shapes the field may take", () => {
  for (const value of ["0.4.0", "0.4.0-rc1", "1.2.3-beta.2", "1.2.3+build.5", "1.2.3-rc.1+abc"]) {
    assert.equal(SEMVER.test(value), true, `${value} should be accepted`);
  }
  for (const value of ["0.4.0.rc1", "0.4", "v0.4.0-rc1", "0.4.0-", "", "0.4.0 rc1"]) {
    assert.equal(SEMVER.test(value), false, `${value} should be rejected`);
  }
});

test("the version is read from the field, not from the text around it", () => {
  assert.equal(versionOf('{"name":"sd-shell","version":"0.4.0-rc1"}'), "0.4.0-rc1");
});
