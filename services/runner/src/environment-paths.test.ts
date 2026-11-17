// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { win32 } from "node:path";

import {
  CACHE_MEMBER_TAIL_CHARS,
  COMPACT_DIRECTORY_ID_CHARS,
  MAX_PATH_USABLE,
  PREFIX_MEMBER_TAIL_CHARS,
  PathBudgetExceededError,
  channelDirectory,
  defaultPackageCacheRoot,
  describePathBudgetProblems,
  environmentDirectoryName,
  inspectPathBudget,
  looksLikePathLengthFailure,
  revisionDirectoryName,
} from "./environment-paths.js";

/** A cache root of exactly `length` characters, so the boundary is the only variable. */
function cacheRootOfLength(length: number): string {
  return "C:\\" + "a".repeat(Math.max(1, length - 3));
}

test("the budget boundary is 259 usable characters, and 260 is over", () => {
  // The report's numbers: 259 resolves, 260 does not, for extraction and linking
  // alike. Both trees are checked against the same ceiling here so a future
  // change cannot quietly give one of them a different allowance.
  const atLimit = cacheRootOfLength(MAX_PATH_USABLE - CACHE_MEMBER_TAIL_CHARS - 44);
  const overLimit = cacheRootOfLength(MAX_PATH_USABLE - CACHE_MEMBER_TAIL_CHARS - 44 + 1);
  assert.equal(channelDirectory(atLimit, "conda-forge", "win32").length + CACHE_MEMBER_TAIL_CHARS, MAX_PATH_USABLE);
  assert.deepEqual(inspectPathBudget({ cacheRoot: atLimit, channels: ["conda-forge"], platform: "win32", revisionPrefix: "C:\\short" }), []);
  const problems = inspectPathBudget({ cacheRoot: overLimit, channels: ["conda-forge"], platform: "win32", revisionPrefix: "C:\\short" });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.area, "package-cache");
  assert.equal(problems[0]!.reach - problems[0]!.limit, 1);
});

test("the reported default data directory fits once revision directories are compact", () => {
  // Observed in the product: this prefix was 154 characters and the deepest
  // member 129, i.e. 283 and 24 over, so the managed Shell never became ready.
  const dataDir = String.raw`C:\Users\33135\AppData\Local\ScienceDiscovery`;
  const taskId = `task-${"0".repeat(36)}`;
  const revisionId = `rev-${"0".repeat(36)}`;
  const compact = win32.join(dataDir, "scientific-envs", "revisions",
    environmentDirectoryName(taskId), revisionDirectoryName(revisionId));
  const legacy = win32.join(dataDir, "scientific-envs", "revisions", taskId, revisionId);

  assert.equal(legacy.length + PREFIX_MEMBER_TAIL_CHARS, 283, "the report's exact arithmetic");
  assert.equal(compact.length, 106);
  assert.ok(compact.length + PREFIX_MEMBER_TAIL_CHARS <= MAX_PATH_USABLE);
  assert.deepEqual(inspectPathBudget({
    cacheRoot: "C:\\ProgramData\\ScienceDiscovery\\pkgs", channels: ["conda-forge"],
    platform: "win32", revisionPrefix: compact,
  }), []);

  // Also cover a longer profile directory name without assuming a global
  // upper bound on custom Windows profile paths.
  const longest = win32.join(`C:\\Users\\${"u".repeat(20)}\\AppData\\Local\\ScienceDiscovery`,
    "scientific-envs", "revisions", environmentDirectoryName(taskId), revisionDirectoryName(revisionId));
  assert.ok(longest.length + PREFIX_MEMBER_TAIL_CHARS <= MAX_PATH_USABLE,
    `${longest.length} + ${PREFIX_MEMBER_TAIL_CHARS} under a 20-character username`);

  assert.equal(environmentDirectoryName("starter-python"), "starter-python");
  assert.equal(environmentDirectoryName("starter-r"), "starter-r");
  assert.equal(environmentDirectoryName(taskId).length, "task-".length + COMPACT_DIRECTORY_ID_CHARS);
  assert.equal(revisionDirectoryName(revisionId).length, "rev-".length + COMPACT_DIRECTORY_ID_CHARS);
});

test("compact names preserve short safe catalog ids and reject unsafe paths", () => {
  assert.equal(environmentDirectoryName("task-abcd"), "task-abcd");
  assert.equal(revisionDirectoryName("rev-abcd"), "rev-abcd");
  assert.equal(environmentDirectoryName("task-ab-cd"), "task-ab-cd");
  for (const id of ["task-../abcd", "task-abcd/ef", "task-abcd\\ef", "task-", "other-abcd"]) {
    assert.throws(() => environmentDirectoryName(id), /unsafe identifier/);
  }
  for (const id of ["rev-../abcd", "rev-abcd/ef", "rev-abcd\\ef", "rev-", "other-abcd"]) {
    assert.throws(() => revisionDirectoryName(id), /unsafe identifier/);
  }
});

test("a too-deep custom data directory still fails the environment-prefix budget", () => {
  // The compact layout buys room, it does not remove the guard: a custom root
  // that leaves less than 129 characters below the prefix for the deepest
  // package member is still refused before provisioning.
  const deep = win32.join("C:\\" + "d".repeat(80), "scientific-envs", "revisions",
    environmentDirectoryName(`task-${"1".repeat(36)}`), revisionDirectoryName(`rev-${"1".repeat(36)}`));
  const problems = inspectPathBudget({
    cacheRoot: "C:\\ProgramData\\ScienceDiscovery\\pkgs", channels: ["conda-forge"],
    platform: "win32", revisionPrefix: deep,
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.area, "environment-prefix");
  assert.ok(problems[0]!.reach > MAX_PATH_USABLE);
  assert.match(describePathBudgetProblems(problems, false), /Move the Runner data directory at least \d+ characters shallower/);
});

test("the shipped Windows default cache root fits the budget with room to spare", () => {
  const root = defaultPackageCacheRoot("win32", { ProgramData: "C:\\ProgramData" });
  assert.equal(root, "C:\\ProgramData\\ScienceDiscovery\\pkgs");
  assert.ok(root!.length <= 72, `root ${root!.length} characters leaves no room for the channel layout`);
  assert.deepEqual(inspectPathBudget({
    cacheRoot: root!, channels: ["conda-forge"], platform: "win32",
    revisionPrefix: "C:\\short\\scientific-envs\\revisions\\starter-python\\rev-00000000-0000-0000-0000-000000000000",
  }), [], "a short data directory and the machine-level cache root are both addressable");
});

test("the cache root stops following the instance data directory on Windows only", () => {
  // The defect: <dataDir>\scientific-envs\provisioner\pkgs spends 33 characters
  // on layout before the channel suffix, so a realistic data directory lands
  // entries past the ceiling. Windows gets a root of its own; POSIX keeps the
  // data-directory layout because MAX_PATH does not apply there.
  assert.equal(defaultPackageCacheRoot("linux", { ProgramData: "C:\\ProgramData" }), undefined);
  assert.equal(defaultPackageCacheRoot("darwin", {}), undefined);
  assert.equal(defaultPackageCacheRoot("win32", { SystemDrive: "D:" }), "D:\\ProgramData\\ScienceDiscovery\\pkgs");
});

test("a deep data directory reaches the same ceiling through the revision prefix", () => {
  // JinhZhao's follow-up puts the environment-prefix wall near a 90-character
  // data directory; the point of checking both trees is that shortening the
  // cache root alone does not make every tree addressable.
  const revisionPrefix = `C:\\${"d".repeat(80)}\\scientific-envs\\revisions\\starter-python\\rev-0123`;
  const problems = inspectPathBudget({ cacheRoot: "C:\\ProgramData\\ScienceDiscovery\\pkgs", channels: ["conda-forge"], platform: "win32", revisionPrefix });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.area, "environment-prefix");
  assert.match(describePathBudgetProblems(problems, false), /Move the Runner data directory at least \d+ characters shallower/);
});

test("the diagnostic names the path, both lengths, the platform policy and the remedy", () => {
  const problems = inspectPathBudget({
    cacheRoot: `C:\\${"a".repeat(80)}`, channels: ["conda-forge"], platform: "win32", revisionPrefix: "C:\\short",
  });
  const text = describePathBudgetProblems(problems, false);
  assert.match(text, new RegExp(`at or under ${MAX_PATH_USABLE} characters`));
  assert.match(text, /LongPathsEnabled: 0/);
  assert.match(text, /Package cache: C:\\a{80}/);
  assert.match(text, /report the over-long files as missing/);
  assert.match(text, /SCIENCE_AGENT_PACKAGE_CACHE_DIR to a directory of at most 72 characters/);
  assert.match(describePathBudgetProblems(problems, undefined), /LongPathsEnabled: unknown on this host/);
  const error = new PathBudgetExceededError(problems, text);
  assert.equal(error.name, "PathBudgetExceededError");
  assert.equal(error.message, text);
});

test("a URL channel is measured by its own cache layout, and the remedy follows it", () => {
  // micromamba keys the cache by source, so an `https://host/path` channel lands
  // under `https/<host>/<path>` rather than `conda.anaconda.org/<name>`. The
  // built-in TUNA/USTC presets are full URLs, so measuring them as bare names
  // would understate the deepest directory and produce the wrong ceiling.
  const root = "C:\\pkgs";
  assert.equal(channelDirectory(root, "conda-forge", "win32"), "C:\\pkgs\\https\\conda.anaconda.org\\conda-forge\\win-64");
  assert.equal(channelDirectory(root, "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge", "win32"),
    "C:\\pkgs\\https\\mirrors.tuna.tsinghua.edu.cn\\anaconda\\cloud\\conda-forge\\win-64");
  // The URL channel is deeper, so a root that fits the default one can still be
  // reported — and the ceiling it quotes is its own, not the default's.
  const problems = inspectPathBudget({
    cacheRoot: cacheRootOfLength(70), channels: ["conda-forge"], platform: "win32", revisionPrefix: "C:\\short",
  });
  assert.deepEqual(problems, [], "70 characters still fits the default channel layout");
  const urlProblems = inspectPathBudget({
    cacheRoot: cacheRootOfLength(70), channels: ["https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge"],
    platform: "win32", revisionPrefix: "C:\\short",
  });
  assert.equal(urlProblems.length, 1);
  const text = describePathBudgetProblems(urlProblems, false);
  const match = /directory of at most (\d+) characters/.exec(text);
  assert.ok(match, text);
  const ceiling = Number(match[1]);
  assert.ok(ceiling < 72, `the URL channel's ceiling ${ceiling} must be below the default channel's 72`);
  assert.equal(channelDirectory(cacheRootOfLength(ceiling), "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge", "win32").length
    + CACHE_MEMBER_TAIL_CHARS, MAX_PATH_USABLE, "the quoted ceiling is exactly what fits");
});

test("the libmamba path-length signature is recognised, an ordinary solver error is not", () => {
  // Translated rather than fixed: the validation and removal happen inside the
  // pinned binary, so what this repository owns is the message the operator
  // acts on. "Package cache is corrupt" invites the remedy that reproduces it.
  assert.equal(looksLikePathLengthFailure("warning  libmamba Invalid package cache, file '<x>\\a.pyc' is missing"), true);
  assert.equal(looksLikePathLengthFailure("error    libmamba Cannot find a valid extracted directory cache for 'a.conda'"), true);
  assert.equal(looksLikePathLengthFailure('error    libmamba Error when extracting package: remove_all: The directory is not empty.: "<x>"'), true);
  assert.equal(looksLikePathLengthFailure("nothing provides pysam needed by pysam"), false);
  assert.equal(looksLikePathLengthFailure("Could not solve for environment specs"), false);
});
