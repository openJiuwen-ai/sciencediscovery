// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

/**
 * A version change is a release change (#1254).
 *
 * `application/package.json`'s `version` is the single source of truth: it
 * names the Windows installer (`electron-builder.yml`'s `artifactName` expands
 * `${version}`), it becomes the exe's FileVersion/ProductVersion, and it is
 * what a support conversation quotes. Nothing here enforced that, so a
 * functional pull request (`#1197`, an MCP fix) moved it from `0.4.0` to
 * `0.4.1` with a one-line edit, and `main` advertised a version no release
 * had while every job stayed green.
 *
 * Every place that used to hand-write the number now derives it from this one
 * field, so changing the version is a one-file edit:
 *
 *  - `electron-builder.yml` `artifactName` uses the `${version}` macro, which
 *    expands the field directly (a pre-release keeps the hyphen spelling, e.g.
 *    `0.5.0-rc1`, not the dot spelling `0.5.0.rc1` that was never valid
 *    SemVer);
 *  - the NSIS syntax-check stub no longer mirrors `VERSION` (`installer.nsh`
 *    never reads it), and the README badge is a dynamic "latest release" badge.
 *
 * What remains to check is two things, and both are needed:
 *
 *  1. the pull request says it is a release change — title `chore(release): …`;
 *  2. the new version is SemVer-shaped, so electron-updater can compare it and
 *     the installer name stays a predictable `ScienceDiscovery-<v>-…`.
 *
 * This lives in `.ci/` rather than as a `ci.yml` step because the repository
 * has one frozen test plan: a command check gets a planned identity there and
 * is selected, counted and reported like any other case, whereas a step added
 * to a workflow is invisible to the catalog guard and can later be half-wired
 * while still looking green. The verdict is computed by the policy job, the
 * only job with the pull request's history, and its own cases run in the UT
 * slice with every other `.ci/*.test.mjs`.
 *
 * Known gap, deliberate: the title half is checked when the pull request runs.
 * Retitling afterwards does not re-run this (that would re-run the whole suite
 * on every body edit), and the merge queue is not checked — its base has moved,
 * so there is nothing stable to compare the version against. A retitled pull
 * request can therefore merge with release-note classification that disagrees
 * with its title; the version cannot drift from its own field the same way,
 * because changing it needs a push, which re-runs everything.
 */

/**
 * SemVer-shaped, optionally pre-release and build metadata.
 *
 * A shape test, not the full grammar: it exists to reject the dot spelling
 * (`0.4.0.rc1`, `semver.valid() === null`) that already shipped once, and to
 * keep the field comparable by electron-updater, which needs a real SemVer
 * version.
 */
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export const VERSION_FILE = "application/package.json";
export const RELEASE_TITLE = /^chore\(release\):/u;

/** The version field of a `package.json` body. */
export function versionOf(text) {
  return JSON.parse(text).version;
}

/**
 * The spelling to write instead of a rejected one.
 *
 * Both rewrites run in order — a leading `v` first, then a fourth dot segment —
 * because running only one of them is how `0.4.0.1` was once told to use
 * `0.4.0.1` and `v0.4.0.rc1` was told to use `0.4.0.rc1`: the rejected value
 * echoed back. The result always differs from the input, or it is the shape to
 * write instead of a guess.
 */
export function semverSuggestion(version) {
  const withoutPrefix = /^v(.+)$/u.exec(version)?.[1] ?? version;
  const dotSuffixed = /^(\d+\.\d+\.\d+)\.(.+)$/u.exec(withoutPrefix);
  if (dotSuffixed) return `${dotSuffixed[1]}-${dotSuffixed[2]}`;
  if (withoutPrefix !== version) return withoutPrefix;
  return "<major>.<minor>.<patch>[-<suffix>]";
}

/**
 * The verdict for one pull request.
 *
 * Pure: the version it moved *from* and *to*, plus the pull request title.
 * There is no file set to compare — every other place the number used to be
 * spelled now derives from `application/package.json` — so only the SemVer
 * shape and the release title are left to enforce.
 */
export function assessVersionChange({ baseVersion, headVersion, title }) {
  const trimmed = (title ?? "").trim();
  if (headVersion === baseVersion) {
    return { ok: true, reason: `${VERSION_FILE} stays at ${headVersion}.` };
  }
  if (!SEMVER.test(headVersion)) {
    return {
      ok: false,
      reason: `${VERSION_FILE} moves to "${headVersion}", which is not a SemVer version. `
        + `write it "${semverSuggestion(headVersion)}" instead.`,
    };
  }
  if (!RELEASE_TITLE.test(trimmed)) {
    return {
      ok: false,
      reason: `${VERSION_FILE} moves ${baseVersion} -> ${headVersion}, which is a release change, but the title `
        + `"${trimmed}" does not start with "chore(release):". `
        + "A version bump belongs to a release: title the pull request `chore(release): …` and change "
        + "`application/package.json` alone. A functional change must not touch the version at all.",
    };
  }
  return {
    ok: true,
    reason: `${VERSION_FILE} moves ${baseVersion} -> ${headVersion} as a release change.`,
  };
}
