// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

/**
 * A version change is a release change (#1254).
 *
 * `application/package.json`'s `version` is not a label: it names the Windows
 * installer (`artifactName`), it becomes the exe's FileVersion/ProductVersion,
 * and it is what a support conversation quotes. Nothing here enforced that, so a
 * functional pull request (`#1197`, an MCP fix) moved it from `0.4.0` to `0.4.1`
 * with a one-line edit, and `main` advertised a version no release had while
 * every job stayed green.
 *
 * The rule has two halves, and both are needed:
 *
 *  1. the pull request says it is a release change — title `chore(release): …`;
 *  2. every place the release number is written by hand carries the **new**
 *     number, not merely a diff that touched the file, and carries it as a whole
 *     token.
 *
 * Both halves of (2) are easy to get wrong. Touching `electron-builder.yml`
 * while leaving `ScienceDiscovery-0.4.0.rc1-…` in place is the original defect
 * wearing a release title. And a plain substring test is not enough either:
 * `0.4.0` is a prefix of `0.4.0.rc1`, so a GA release moving `0.4.0-rc1 ->
 * 0.4.0` would pass while the installer stayed named `0.4.0.rc1` and the badges
 * still linked `v0.4.0-rc1` — the same drift. Every check below therefore
 * matches a whole token with its delimiter (`ScienceDiscovery-<v>-`, `!define
 * VERSION "<v>"`, `Release-<v>-`, `releases/tag/v<v>` followed by a boundary).
 *
 * This lives in `.ci/` rather than as a `ci.yml` step because the repository has
 * one frozen test plan: a command check gets a planned identity there and is
 * selected, counted and reported like any other case, whereas a step added to a
 * workflow is invisible to the catalog guard and can later be half-wired while
 * still looking green. The verdict is computed by the policy job, the only job
 * with the pull request's history, and its own cases run in the UT slice with
 * every other `.ci/*.test.mjs`.
 *
 * Known gap, deliberate: the title half is checked when the pull request runs.
 * Retitling afterwards does not re-run this (that would re-run the whole suite on
 * every body edit), and the merge queue is not checked — its base has moved, so
 * there is nothing stable to compare the version against. A retitled pull
 * request can therefore merge with release-note classification that disagrees
 * with its title; the version and its metadata cannot drift the same way,
 * because changing them needs a push, which re-runs everything.
 */

/** `0.4.0-rc1` -> `0.4.0.rc1`: the form a file name may take. */
export function dotForm(version) {
  const hyphen = version.indexOf("-");
  return hyphen < 0 ? version : `${version.slice(0, hyphen)}.${version.slice(hyphen + 1)}`;
}

/** electron-builder's expansion of the version field. */
export const VERSION_MACRO = "${version}";

/**
 * SemVer-shaped, optionally pre-release and build metadata.
 *
 * A shape test, not the full grammar: it exists to reject the dot spelling
 * (`0.4.0.rc1`, `semver.valid() === null`) that already shipped once, and to keep
 * the field comparable by electron-updater, which needs a real SemVer version.
 */
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where the release number is written by hand. A literal list on purpose: a new
 *  place to write the number should force somebody to come back to this file.
 *
 *  The Windows matcher is pinned to `-win-x64-setup.`, the suffix
 *  `electron-builder.yml` uses today. A second installer target would have to be
 *  added here, which is the moment to read this comment. */
export const RELEASE_METADATA = Object.freeze([
  "application/electron-builder.yml",
  "application/build/nsh-syntax-check-stub.nsi",
  "README.md",
  "README_zh.md",
]);

/**
 * The exact token each metadata file must contain.
 *
 * Each entry is `{path, checks}`; every check has to pass, and a check is one
 * literal with its delimiter, so `0.4.0` never satisfies a file that says
 * `0.4.0.rc1`.
 */
export function requirementsFor(version) {
  const dot = dotForm(version);
  const preRelease = version.includes("-");
  // At GA the documented policy puts `${version}` back in the artifact name; it
  // cannot drift from the field it expands, so either spelling is accepted.
  const names = preRelease ? [dot] : [dot, VERSION_MACRO];
  return RELEASE_METADATA.map((path) => {
    if (path === "application/electron-builder.yml") {
      return {
        checks: [{
          expected: names.map((name) => `ScienceDiscovery-${name}-`).join(" or "),
          matches: new RegExp(`ScienceDiscovery-(?:${names.map(escapeRegExp).join("|")})-win-x64-setup\\.`, "u"),
        }],
        path,
      };
    }
    if (path === "application/build/nsh-syntax-check-stub.nsi") {
      return {
        checks: [{
          expected: `!define VERSION "${dot}"`,
          matches: new RegExp(`!define VERSION "${escapeRegExp(dot)}"`, "u"),
        }],
        path,
      };
    }
    // The badge is read by a person (dot form, hyphen-delimited in the badge URL)
    // and links the tag (hyphen form, boundary after it).
    return {
      checks: [
        { expected: `Release-${dot}-`, matches: new RegExp(`Release-${escapeRegExp(dot)}-`, "u") },
        {
          expected: `releases/tag/v${version}`,
          matches: new RegExp(`releases/tag/v${escapeRegExp(version)}(?![0-9A-Za-z.-])`, "u"),
        },
      ],
      path,
    };
  });
}

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
 * Pure: `files` maps each metadata path to its text as it stands in the pull
 * request, so the rule can be tested without a repository and the caller can
 * supply whatever it read. A path mapped to `undefined` is a file that is not
 * there; it is reported rather than thrown.
 */
export function assessVersionChange({ baseVersion, files, headVersion, title }) {
  const trimmed = (title ?? "").trim();
  if (headVersion === baseVersion) {
    return { ok: true, reason: `${VERSION_FILE} stays at ${headVersion}.` };
  }
  if (!SEMVER.test(headVersion)) {
    return {
      ok: false,
      reason: `${VERSION_FILE} moves to "${headVersion}", which is not a SemVer version. `
        + `The dot spelling belongs in file names only; write it "${semverSuggestion(headVersion)}" instead.`,
    };
  }

  const problems = [];
  if (!RELEASE_TITLE.test(trimmed)) {
    problems.push(`the title "${trimmed}" does not start with "chore(release):"`);
  }
  for (const { checks, path } of requirementsFor(headVersion)) {
    const text = files[path];
    if (typeof text !== "string") {
      problems.push(`${path} could not be read`);
      continue;
    }
    for (const { expected, matches } of checks) {
      if (!matches.test(text)) {
        problems.push(`${path} does not carry ${expected}`);
      }
    }
  }
  if (problems.length === 0) {
    return {
      ok: true,
      reason: `${VERSION_FILE} moves ${baseVersion} -> ${headVersion} as a release change, `
        + "and every place the release is spelled carries the new number.",
    };
  }
  return {
    ok: false,
    reason: `${VERSION_FILE} moves ${baseVersion} -> ${headVersion}, which is a release change, but `
      + `${problems.join("; ")}. `
      + "A version bump belongs to a release: title the pull request `chore(release): …` and move every "
      + `place the release is spelled, with the new number in it (${RELEASE_METADATA.join(", ")}). `
      + "A functional change must not touch the version at all.",
  };
}
