// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * A version change is a release change (#1254).
 *
 * `application/package.json`'s `version` is not a label: it names the Windows
 * installer (`artifactName`), it becomes the exe's FileVersion/ProductVersion,
 * and it is what a support conversation quotes. Nothing in the repository
 * enforced that, so a functional PR (`#1197`, an MCP fix) moved it from `0.4.0`
 * to `0.4.1` with a one-line edit, and `main` advertised a version that no
 * release had while every CI job stayed green.
 *
 * This check closes that door. When the version moves in a pull request it must
 * be a release change in both senses:
 *
 *   1. the title says so — `chore(release): …`; and
 *   2. the same diff moves every other place the release is spelled.
 *
 * Requiring both is deliberate. The title alone would be a password anyone could
 * type; the file set alone would let a functional PR bump the version as long as
 * it also nudged a README line. Together they describe the `#1147` change, which
 * is the shape every release is supposed to take.
 *
 * The metadata set is not arbitrary — each entry is a place the release number
 * is written by hand. `artifactName` is pinned instead of interpolating
 * `${version}`, because the dot spelling (`0.4.0.rc1`) is a file-name form that
 * SemVer forbids, and pinning it is what keeps the two spellings from drifting
 * (`#1147` documented exactly that).
 *
 * Nothing here runs on a push or in the merge queue: by then the pull request has
 * already been checked, and the queue re-runs the same commit.
 */

import { execFileSync } from "node:child_process";

export const VERSION_FILE = "application/package.json";

/** The title prefix a release change carries. */
export const RELEASE_TITLE = /^chore\(release\):/u;

/**
 * Every file outside `package.json` that spells the release number by hand.
 *
 * Deliberately a list, not a glob: a new place to write the number should force
 * somebody to come back here, which is the moment they read the header above.
 */
export const RELEASE_METADATA = [
  "application/electron-builder.yml",
  "application/build/nsh-syntax-check-stub.nsi",
  "README.md",
  "README_zh.md",
];

/**
 * SemVer-shaped, optionally pre-release and build metadata.
 *
 * This is a shape test, not the full SemVer grammar: it exists to reject the dot
 * spelling (`0.4.0.rc1`, `semver.valid() === null`) that already shipped once,
 * and to keep the field comparable by electron-updater, which needs a real
 * SemVer version. `0.4.0.rc1` fails it because the extra `.rc1` is a fourth dot
 * segment, not a pre-release.
 */
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** The version field of a `package.json` body. */
export function versionOf(text) {
  return JSON.parse(text).version;
}

/**
 * The verdict for one pull request.
 *
 * Pure so the rule can be tested without a repository: the CLI below only
 * supplies what git and the event say.
 */
export function checkVersionChange({ baseVersion, changedPaths, headVersion, title }) {
  const trimmed = title.trim();
  if (headVersion === baseVersion) {
    return { ok: true, reason: `${VERSION_FILE} stays at ${headVersion}.` };
  }
  if (!SEMVER.test(headVersion)) {
    return {
      ok: false,
      reason: `${VERSION_FILE} moves to "${headVersion}", which is not a SemVer version. `
        + `The dot spelling belongs in file names only; write it "${headVersion.replace(/\.(rc|beta|alpha)(\d+)$/u, "-$1$2")}" instead.`,
    };
  }
  const touched = new Set(changedPaths);
  const missing = RELEASE_METADATA.filter((path) => !touched.has(path));
  const titled = RELEASE_TITLE.test(trimmed);
  if (titled && missing.length === 0) {
    return {
      ok: true,
      reason: `${VERSION_FILE} moves ${baseVersion} -> ${headVersion} as a release change, `
        + "with the artifact name, the NSIS stub and both READMEs moved with it.",
    };
  }
  const problems = [];
  if (!titled) {
    problems.push(`the title "${trimmed}" does not start with "chore(release):"`);
  }
  if (missing.length > 0) {
    problems.push(`it does not update ${missing.join(", ")}`);
  }
  return {
    ok: false,
    reason: `${VERSION_FILE} moves ${baseVersion} -> ${headVersion}, which is a release change, but `
      + `${problems.join("; and ")}. `
      + "A version bump belongs to a release: title the pull request `chore(release): …` and move every "
      + `place the release is spelled (${RELEASE_METADATA.join(", ")}). `
      + "A functional change must not touch the version at all.",
  };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/**
 * What the pull request changed, relative to its base.
 *
 * Three dots (the merge base) rather than two: a branch that is behind `main`
 * would otherwise show `main`'s own edits as this pull request's. It needs the
 * base commit in the clone, which the workflow provides by checking out with
 * full history; a shallow clone fails here loudly instead of guessing.
 */
function changedPaths(baseSha) {
  return git(["diff", "--name-only", `${baseSha}...HEAD`]).split("\n").filter(Boolean);
}

function run() {
  const baseSha = process.env.BASE_SHA?.trim();
  const title = process.env.PR_TITLE ?? "";
  if (!baseSha) throw new Error("BASE_SHA is required: this check compares the pull request with its base");

  const baseVersion = versionOf(git(["show", `${baseSha}:${VERSION_FILE}`]));
  const headVersion = versionOf(git(["show", `HEAD:${VERSION_FILE}`]));
  const verdict = checkVersionChange({
    baseVersion,
    changedPaths: changedPaths(baseSha),
    headVersion,
    title,
  });
  if (verdict.ok) {
    console.log(`release version OK: ${verdict.reason}`);
    return;
  }
  throw new Error(`release version check failed: ${verdict.reason}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
