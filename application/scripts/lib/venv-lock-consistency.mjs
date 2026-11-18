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
 * PEP 503 name normalization. The two sides spell names differently in practice:
 * `importlib.metadata` reports the project name as published (`pydantic_core`,
 * `discord.py`, `huggingface_hub`), while `uv.lock` writes the normalized form
 * (`pydantic-core`, `discord-py`, `huggingface-hub`). Without this the lookup
 * silently skips those packages, which is the one direction this gate exists for.
 */
export function normalizeDistributionName(name) {
  return String(name ?? "").toLowerCase().replace(/[-_.]+/g, "-");
}

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
    if (!name || !version) continue;
    const key = normalizeDistributionName(name);
    // One name can legitimately appear several times: uv writes a block per
    // `resolution-markers` branch (numpy resolves 2.4.6 for <3.12 and 2.5.4 for
    // >=3.12). Keeping the set means a venv whose interpreter picked either
    // branch is accepted, instead of depending on which block came last.
    const pinned = versions.get(key);
    if (pinned) pinned.add(version);
    else versions.set(key, new Set([version]));
  }
  return versions;
}

/** Normalize the snapshot program's output to `{ name: version }`, lower-cased. */
export function parseDistributionSnapshot(text) {
  const raw = JSON.parse(String(text ?? "{}"));
  const versions = Object.create(null);
  for (const [name, version] of Object.entries(raw ?? {})) {
    if (typeof name === "string" && name && typeof version === "string") {
      versions[normalizeDistributionName(name)] = version;
    }
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
  for (const [name, pinned] of parseUvLockVersions(lockText)) {
    const actual = installed?.[name];
    if (actual === undefined) continue;
    if (!pinned.has(actual)) problems.push({ installed: actual, locked: [...pinned].sort(), name });
  }
  return problems;
}

/** The refusal text; names the same repair command the end-of-run gate uses. */
export function venvPreflightFailure(problems) {
  const named = problems.slice(0, 5).map((problem) => `${problem.name} ${problem.installed} `
    + `(uv.lock requires ${problem.locked.join(" or ")})`);
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
