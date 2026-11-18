// Venv / patch-set lock consistency (issue #1218).
//
// `jiuwenswarm.mjs setup` provisions the JiuwenSwarm venv with
// `uv sync` against the *patched* `uv.lock`. Applying a dependency-carrying
// swarm patch (0018, 0019, 0021, …) rewrites that lock but leaves an existing
// venv alone, so a packaging run on such a machine used to discover the skew
// only at the very end of `assemble`, after the whole payload had been written.
//
// The comparison is deliberately lockfile-driven rather than a list of package
// names: whatever a future patch pins in `uv.lock` is checked, and packages the
// lock lists for other platforms or extras are ignored because the venv does
// not install them.

/** The Python one-liner that prints every installed distribution as JSON. */
export const DISTRIBUTION_SNAPSHOT_PROGRAM =
  "import json,importlib.metadata as md;"
  + "print(json.dumps({(d.metadata['Name'] or '').lower(): d.version for d in md.distributions()}))";

/**
 * `uv.lock` pins one resolved version per package. Only the `[[package]]`
 * blocks that carry both `name` and `version` are read; the workspace metadata
 * blocks at the top of the file have neither.
 */
export function parseUvLockVersions(text) {
  const versions = new Map();
  for (const block of String(text ?? "").split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name && version) versions.set(name.toLowerCase(), version);
  }
  return versions;
}

/** Normalize the snapshot program's output to `{ name: version }`, lower-cased. */
export function parseDistributionSnapshot(text) {
  const raw = JSON.parse(String(text ?? "{}"));
  const versions = Object.create(null);
  for (const [name, version] of Object.entries(raw ?? {})) {
    if (typeof name === "string" && name && typeof version === "string") versions[name.toLowerCase()] = version;
  }
  return versions;
}

/**
 * Packages whose installed version differs from the pin in the patched lock.
 *
 * A package the venv does not have is not a mismatch: `uv.lock` covers every
 * platform and optional group, and the venv installs a subset. The direction
 * this check exists for is the reverse — an installed package that is older
 * than what the patch set resolved.
 */
export function venvLockSkew(lockText, installed) {
  const problems = [];
  for (const [name, locked] of parseUvLockVersions(lockText)) {
    const actual = installed?.[name];
    if (actual === undefined) continue;
    if (actual !== locked) problems.push({ installed: actual, locked, name });
  }
  return problems;
}

/** The refusal text; names the same repair command the end-of-run gate uses. */
export function venvPreflightFailure(problems) {
  const named = problems.slice(0, 5).map((problem) => `${problem.name} ${problem.installed} (uv.lock requires ${problem.locked})`);
  const rest = problems.length - named.length;
  return "jw venv preflight FAILED: the venv does not match the swarm patch set: "
    + `${named.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}. `
    + "A dependency-carrying patch rewrote the lockfile but the venv predates it. "
    + "Re-run node scripts/jiuwenswarm.mjs setup (or bash scripts/jiuwenswarm.sh setup), then rebuild.";
}

/**
 * The whole decision, from the two inputs the caller already has, so it can be
 * exercised without provisioning a venv: `null` means the two agree.
 */
export function venvPreflightProblem(lockText, installed) {
  const problems = venvLockSkew(lockText, installed);
  return problems.length ? venvPreflightFailure(problems) : null;
}
