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
 *     number, not merely a diff that touched the file.
 *
 * The second half is the one that is easy to get wrong. Touching
 * `electron-builder.yml` while leaving `ScienceDiscovery-0.4.0.rc1-…` in place
 * is the original defect wearing a release title: an installer named for a
 * version it does not have, and a README badge linking a tag that 404s.
 *
 * This lives in `.ci/` rather than as a `ci.yml` step because the repository has
 * one frozen test plan: a command check gets a planned identity there and is
 * selected, counted and reported like any other case, whereas a step added to a
 * workflow is invisible to the catalog guard and can later be half-wired while
 * still looking green. The verdict is computed by the policy job, the only job
 * with the pull request's history, and its own cases run in the UT slice with
 * every other `.ci/*.test.mjs`.
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

/**
 * Every place the release number is written by hand, and what it must say.
 *
 * An entry lists requirement *groups*: every group has to be satisfied, and a
 * group is satisfied by any one of its spellings. That shape is what lets the
 * README need two different strings (the badge and the tag it links) while the
 * artifact name has a choice.
 */
export function requirementsFor(version) {
  const preRelease = version.includes("-");
  return [
    {
      path: "application/electron-builder.yml",
      groups: preRelease
        // A pre-release is spelled with a dot in the file name — a form SemVer
        // forbids in the version field — so the literal is the only thing that can
        // stand for it: `${version}` would expand to the hyphen form and rename
        // the installer.
        ? [["dot"]]
        // At GA the documented policy (`scripts/package-sd-windows.sh`) puts the
        // `${version}` macro back. The macro cannot drift from the field it
        // expands, so either spelling is accepted here.
        : [["dot", "macro"]],
    },
    { groups: [["dot"]], path: "application/build/nsh-syntax-check-stub.nsi" },
    // The badge is read by a person (dot form) and links the tag (hyphen form).
    { groups: [["dot"], ["tag"]], path: "README.md" },
    { groups: [["dot"], ["tag"]], path: "README_zh.md" },
  ];
}

/** The paths `requirementsFor` covers, for messages. */
export const RELEASE_METADATA = Object.freeze(requirementsFor("0.0.0").map(({ path }) => path));

export const VERSION_FILE = "application/package.json";
export const RELEASE_TITLE = /^chore\(release\):/u;

/** The version field of a `package.json` body. */
export function versionOf(text) {
  return JSON.parse(text).version;
}

export function spellingOf(kind, version) {
  if (kind === "dot") return dotForm(version);
  if (kind === "tag") return `v${version}`;
  if (kind === "macro") return VERSION_MACRO;
  throw new Error(`unknown spelling: ${kind}`);
}

/**
 * The verdict for one pull request.
 *
 * Pure: `files` maps each metadata path to its text as it stands in the pull
 * request, so the rule can be tested without a repository and the caller can
 * supply whatever it read.
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
        + `The dot spelling belongs in file names only; write it "${headVersion.replace(/\.(rc|beta|alpha)(\d+)$/u, "-$1$2")}" instead.`,
    };
  }

  const problems = [];
  if (!RELEASE_TITLE.test(trimmed)) {
    problems.push(`the title "${trimmed}" does not start with "chore(release):"`);
  }
  for (const { groups, path } of requirementsFor(headVersion)) {
    const text = files[path];
    if (typeof text !== "string") {
      problems.push(`${path} could not be read`);
      continue;
    }
    groups.forEach((alternatives, index) => {
      const wanted = alternatives.map((kind) => `"${spellingOf(kind, headVersion)}"`);
      const satisfied = alternatives.some((kind) => text.includes(spellingOf(kind, headVersion)));
      if (!satisfied) {
        const which = groups.length > 1 ? (index === 0 ? " (its spelling)" : " (its tag link)") : "";
        problems.push(`${path}${which} does not carry ${wanted.join(" or ")}`);
      }
    });
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
