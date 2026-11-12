// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { spawnSync } from "node:child_process";
import { posix, win32 } from "node:path";

/**
 * Windows path-budget accounting for the provisioner's package cache (#1104).
 *
 * micromamba reports a file it just wrote as `is missing`, and then fails to
 * delete and re-extract the entry, when the file's plain absolute path is
 * longer than a normal Win32 path. Measured on the pinned 2.8.1 release with
 * `LongPathsEnabled = 0`: 259 characters resolve, 260 do not — for extraction
 * cache validation and for linking alike, so both phases reduce to one
 * criterion on total length.
 *
 * The concern is not the cache root on its own but the deepest *recorded*
 * member below it, which only the resolved package set knows. These constants
 * therefore reserve for the deepest tail this repository's starter set has been
 * observed to produce, and the pre-flight reports the arithmetic rather than a
 * verdict, so an operator can see exactly how many characters are over.
 */

/** Longest plain path that still resolves; the documented 260 includes the NUL. */
export const MAX_PATH_USABLE = 259;

/**
 * `\https\conda.anaconda.org\conda-forge\win-64` between the cache root and an
 * entry, for the default channel only — a URL channel has its own layout, so
 * every measurement uses `channelDirectory` rather than this. The report's "77"
 * is this plus `\scientific-envs\provisioner\pkgs`, which applies only while the
 * cache lives under the data directory.
 */
export const DEFAULT_CHANNEL_SUFFIX_CHARS = 44;

/**
 * Deepest member below the channel directory in the starter package set
 * (matplotlib-base's `__pycache__` test artefacts). A shallow resolution can
 * come in under this; budgeting for the deep one is what keeps a later repodata
 * refresh from turning a working install into a broken one.
 */
export const CACHE_MEMBER_TAIL_CHARS = 143;

/** Deepest linked member below a revision prefix for the same package set. */
export const PREFIX_MEMBER_TAIL_CHARS = 129;

export type PathBudgetArea = "package-cache" | "environment-prefix";

export interface PathBudgetProblem {
  area: PathBudgetArea;
  /** The directory whose length is the operator's to change. */
  path: string;
  length: number;
  /** Characters the deepest member of this tree needs below `path`. */
  tail: number;
  /** Total this tree reaches, i.e. `length + tail`. */
  reach: number;
  limit: number;
  /**
   * Characters between the operator's root and `path` — the channel layout for
   * the cache, nothing for a revision prefix. The remedy subtracts this instead
   * of a constant, because a URL channel's layout is not the default one.
   */
  suffix: number;
}

/**
 * The separator of the *target* platform, not of the host running the check.
 * A Windows budget measured with the POSIX implementation on a Linux CI host
 * turns `C:\ProgramData` into a relative path and shifts every length, which is
 * how the first version of this file passed on Windows and failed on Linux.
 */
function pathOf(platform: string): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** The sub-directory a channel's packages are cached under. */
export function platformDirectoryName(platform: string): string {
  return platform === "win32" ? "win-64" : "linux-64";
}

/** A channel may be a bare name or a full URL; only the URL part is interesting. */
function channelUrl(channel: string): URL | undefined {
  if (!/^https?:\/\//i.test(channel)) return undefined;
  try {
    return new URL(channel);
  } catch {
    return undefined;
  }
}

/**
 * The package cache root a platform uses when the operator configured none.
 *
 * Windows gets a machine-level root of its own instead of inheriting the
 * per-instance data directory: the cache root is the operator's only lever on
 * the path budget, and `<dataDir>\scientific-envs\provisioner\pkgs` spends 91
 * characters on the layout alone before any package is unpacked. Elsewhere the
 * data directory layout is kept, because MAX_PATH does not apply there.
 */
export function defaultPackageCacheRoot(platform: string, env: NodeJS.ProcessEnv): string | undefined {
  if (platform !== "win32") return undefined;
  const programData = env.ProgramData?.trim() || env.PROGRAMDATA?.trim();
  if (programData) return win32.join(programData, "ScienceDiscovery", "pkgs");
  const systemDrive = env.SystemDrive?.trim() || "C:";
  return win32.join(`${systemDrive}\\`, "ProgramData", "ScienceDiscovery", "pkgs");
}

/**
 * The channel directory the provisioner extracts entries beneath.
 *
 * micromamba keys its cache by source, so a bare channel name lands under
 * `https/conda.anaconda.org/<name>` while an `https://host/path` channel lands
 * under `https/<host>/<path>` — the built-in TUNA/USTC presets are full URLs, so
 * measuring every channel as if it were named would understate those.
 */
export function channelDirectory(cacheRoot: string, channel: string, platform: string): string {
  const join = pathOf(platform).join;
  const platformDir = platformDirectoryName(platform);
  const url = channelUrl(channel);
  if (url) {
    const segments = url.pathname.split("/").filter(Boolean);
    return join(cacheRoot, url.protocol.replace(":", ""), url.hostname, ...segments, platformDir);
  }
  return join(cacheRoot, "https", "conda.anaconda.org", channel, platformDir);
}

/**
 * Every tree whose deepest member has to stay addressable. Reported as a list so
 * the diagnostic names all of them instead of the first one found.
 */
export function inspectPathBudget(input: {
  cacheRoot: string;
  channels: readonly string[];
  platform: string;
  revisionPrefix: string;
}): PathBudgetProblem[] {
  const problems: PathBudgetProblem[] = [];
  for (const channel of input.channels.length ? input.channels : ["conda-forge"]) {
    const path = channelDirectory(input.cacheRoot, channel, input.platform);
    const length = path.length;
    const reach = length + CACHE_MEMBER_TAIL_CHARS;
    if (reach > MAX_PATH_USABLE) {
      problems.push({
        area: "package-cache", path, length, tail: CACHE_MEMBER_TAIL_CHARS, reach, limit: MAX_PATH_USABLE,
        suffix: length - input.cacheRoot.length,
      });
    }
  }
  const prefixLength = input.revisionPrefix.length;
  const prefixReach = prefixLength + PREFIX_MEMBER_TAIL_CHARS;
  if (prefixReach > MAX_PATH_USABLE) {
    problems.push({
      area: "environment-prefix", path: input.revisionPrefix, length: prefixLength,
      tail: PREFIX_MEMBER_TAIL_CHARS, reach: prefixReach, limit: MAX_PATH_USABLE, suffix: 0,
    });
  }
  return problems;
}

/**
 * The one-line remedy per area. Both name the number, because "shorten the path"
 * is not actionable when the operator cannot see how much shorter.
 */
function remedyFor(problem: PathBudgetProblem): string {
  const overBy = problem.reach - problem.limit;
  if (problem.area === "package-cache") {
    // The channel layout is fixed for a given channel, so the root is what shrinks.
    const ceiling = problem.limit - problem.tail - problem.suffix;
    return `Set SCIENCE_AGENT_PACKAGE_CACHE_DIR to a directory of at most ${ceiling} characters `
      + `(this one would need to lose ${overBy}).`;
  }
  return `Move the Runner data directory at least ${overBy} characters shallower; `
    + `the revision prefix is built from it.`;
}

/**
 * The compatibility diagnostic an operator sees instead of libmamba's
 * "file is missing" trail. Deliberately prints the measured lengths and the
 * platform policy, since the state of `LongPathsEnabled` decides whether the
 * numbers are even relevant.
 */
export function describePathBudgetProblems(
  problems: readonly PathBudgetProblem[],
  longPathsEnabled: boolean | undefined,
): string {
  const policy = longPathsEnabled === undefined
    ? "LongPathsEnabled: unknown on this host"
    : `LongPathsEnabled: ${longPathsEnabled ? "1" : "0"}`;
  const lines = [
    `Windows path budget exceeded for managed scientific environments: a member path must stay at or under ${MAX_PATH_USABLE} characters.`,
    policy,
  ];
  for (const problem of problems) {
    lines.push(`${problem.area === "package-cache" ? "Package cache" : "Environment prefix"}: ${problem.path}`);
    lines.push(`  ${problem.length} characters now + ${problem.tail} for the deepest member = ${problem.reach}, ${problem.reach - problem.limit} over.`);
    lines.push(`  ${remedyFor(problem)}`);
  }
  lines.push("Provisioning has not started; micromamba would report the over-long files as missing and then leave the shared cache unusable.");
  return lines.join("\n");
}

/**
 * The system long-path policy, which decides whether the numbers above are even
 * relevant: micromamba's binary declares `longPathAware`, but that declaration is
 * inert while this value is 0. Read-only; a host that refuses the query reports
 * `undefined` rather than a guess.
 */
export function windowsLongPathsEnabled(platform: string = process.platform): boolean | undefined {
  if (platform !== "win32") return undefined;
  const result = spawnSync("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled"],
    { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !result.stdout) return undefined;
  const match = /LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(result.stdout);
  return match ? Number.parseInt(match[1]!, 16) === 1 : undefined;
}

/** Thrown before provisioning when the resolved layout cannot be addressed. */
export class PathBudgetExceededError extends Error {
  constructor(readonly problems: readonly PathBudgetProblem[], readonly diagnostic: string) {
    super(diagnostic);
    this.name = "PathBudgetExceededError";
  }
}

/**
 * Does a provisioning failure carry the signature of a path-length problem?
 *
 * The pinned provisioner cannot be fixed here (`services/runner` does not own
 * the validation and removal inside the binary), so the one thing this
 * repository can do for the message is translate it: as written it says the
 * cache is corrupt, which invites wiping and re-downloading into the same
 * state.
 */
export function looksLikePathLengthFailure(output: string): boolean {
  return /Invalid package cache, file '[^']*' is missing/i.test(output)
    || /Cannot find a valid extracted directory cache/i.test(output)
    || /remove_all: The directory is not empty/i.test(output);
}
