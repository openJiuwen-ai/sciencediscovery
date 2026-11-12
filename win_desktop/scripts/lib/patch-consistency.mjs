// patch-consistency: prove the staged jw tree and the shipped patch set agree.
//
// Field incident (installed 2026-11-12, built 2026-11-12 01:30): the installer
// carried a jw source tree patched by the OLD 0004-platform-mcp-transport.patch
// (receipt digest 7aefc0cb…), but the jiuwen_swarm/patches/ payload carried the
// NEW 0004 (e4427c89…, revised in a7ff1333). assemble-backend copies the two
// halves from different sources at different times — the jw tree from the build
// machine's data dir (data/jiuwenswarm/src, patched when setup last ran there)
// and the patch set from the repository checkout — so a patch revision that
// lands in the repo between the machine's last `jiuwenswarm.mjs setup` and the
// package build ships a payload that can never pass its own runtime verify:
//
//   swarm-patches.py verify → ValueError: Swarm patch verification failed
//   → JiuwenSwarm start dies → the desktop shell polls /agent/info forever
//   → the UI stays on "智能体集群正在启动中…" with no error anywhere.
//
// Every piece of the mismatch is invisible to the existing gates: A1 imports
// still pass (the tree is a valid, consistently patched OLD tree), A2
// required-files still passes (the receipt IS there), and the runtime probe
// never calls swarm-patches. This gate runs the payload's own verifier, against
// the payload's own staged tree, with the payload's own patch set — the exact
// command the shipped installer will run on every cold start (same script copy,
// same default patch dir, same receipt), so a payload that would die in the
// field dies here instead, at build time.
//
// The command is intentionally the runtime command itself (not a JS
// re-implementation of the digest comparison): swarm-patches.py is the
// authority on what "consistent" means, and a JS twin would drift the first
// time the receipt format changes. The tag comes from the staged receipt (not
// from the build environment): the receipt describes the tree actually being
// shipped, so it is the tag the verify must use. A receipt-less tree is a hard
// failure too — the runtime verify reads that same receipt, so its absence is
// already fatal in the field (the A2 required-files list catches it earlier;
// this guard keeps that property even if that list is ever edited).

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The staged receipt's tag, or null when the receipt is missing or unreadable. */
export function stagedPatchTag(jwPayloadDir) {
  try {
    const receipt = JSON.parse(readFileSync(join(jwPayloadDir, ".sciencediscovery-patches.json"), "utf8"));
    return typeof receipt?.tag === "string" && receipt.tag ? receipt.tag : null;
  } catch {
    return null;
  }
}

/**
 * Build the exact argv the runtime uses, as data: the payload's own python
 * running the payload's own copy of swarm-patches.py, verifying the payload's
 * own staged jw tree against the payload's own patch set for the receipt's tag.
 *
 * Returns null when the staged tree has no readable receipt — the caller must
 * fail rather than skip (see the header: absence is fatal in the field).
 */
export function patchVerifyCommand({ jwPython, swarmPatchesPy, jwPayloadDir, tag }) {
  if (!tag) return null;
  // No --patch-dir: the runtime verify resolves the patch set relative to the
  // script's own location (scripts/../jiuwen_swarm/patches/<tag>), which in the
  // staged payload is exactly the patch set being shipped. Passing an explicit
  // dir would re-derive the same path and only add a second place this layout
  // is written down.
  return {
    exe: jwPython,
    args: [swarmPatchesPy, "verify", jwPayloadDir, tag],
  };
}

/** A failure message that tells the builder how to fix the build machine. */
export function patchVerifyFailureDetail({ jwPayloadDir, tag, exitCode, stderr }) {
  const tail = String(stderr ?? "").trim().split(/\r?\n/).filter(Boolean).slice(-4).join("\n");
  return [
    `payload patch consistency check FAILED (exit ${exitCode}).`,
    `The staged jw tree (${jwPayloadDir}) does not match the patch set being shipped${tag ? ` for tag ${tag}` : ""}.`,
    "The jw source tree in the build data dir was patched with an OLDER patch set than the repository's",
    "jiuwen_swarm/patches — refresh it before packaging:",
    "  node scripts/jiuwenswarm.mjs setup   # re-applies the current patch set, rewrites the receipt",
    tail ? `\nverifier output:\n${tail}` : "",
  ].filter(Boolean).join("\n");
}
