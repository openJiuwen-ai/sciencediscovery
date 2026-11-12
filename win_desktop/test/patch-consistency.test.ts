// Field incident (installer built 2026-11-12 01:30): the payload's jw tree was
// patched with an OLDER 0004-platform-mcp-transport.patch (receipt 7aefc0cb…)
// while jiuwen_swarm/patches/ shipped the NEW 0004 (e4427c89…, a7ff1333).
// swarm-patches.py verify died on every cold start, JiuwenSwarm never came up,
// and the desktop UI waited on "智能体集群正在启动中…" forever. These tests pin
// the A2b gate's decisions: the command must be the runtime verify itself
// (payload script + staged tree + the RECEIPT's tag, no --patch-dir), a
// receipt-less staged tree must fail rather than skip, and the failure message
// must tell the builder how to refresh the build data dir.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stagedPatchTag, patchVerifyCommand, patchVerifyFailureDetail } from "../scripts/lib/patch-consistency.mjs";

test("stagedPatchTag reads the receipt's tag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "patch-consistency-"));
  try {
    await writeFile(join(dir, ".sciencediscovery-patches.json"),
      JSON.stringify({ tag: "workswarm0.2.6", patches: {}, files: {} }), "utf8");
    assert.equal(stagedPatchTag(dir), "workswarm0.2.6");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stagedPatchTag returns null for a missing, corrupt, or tagless receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "patch-consistency-"));
  try {
    assert.equal(stagedPatchTag(dir), null, "no receipt at all");
    await writeFile(join(dir, ".sciencediscovery-patches.json"), "{ not json", "utf8");
    assert.equal(stagedPatchTag(dir), null, "corrupt JSON");
    await writeFile(join(dir, ".sciencediscovery-patches.json"), JSON.stringify({ patches: {} }), "utf8");
    assert.equal(stagedPatchTag(dir), null, "receipt without a tag string");
    await writeFile(join(dir, ".sciencediscovery-patches.json"), JSON.stringify({ tag: 42 }), "utf8");
    assert.equal(stagedPatchTag(dir), null, "non-string tag");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("patchVerifyCommand is the runtime verify: payload script, staged tree, receipt tag, no --patch-dir", () => {
  const command = patchVerifyCommand({
    jwPython: "C:\\payload\\backend\\jw\\.venv\\Scripts\\python.exe",
    swarmPatchesPy: "C:\\payload\\backend\\scripts\\swarm-patches.py",
    jwPayloadDir: "C:\\payload\\backend\\jw",
    tag: "workswarm0.2.6",
  });
  assert.deepEqual(command, {
    exe: "C:\\payload\\backend\\jw\\.venv\\Scripts\\python.exe",
    args: ["C:\\payload\\backend\\scripts\\swarm-patches.py", "verify", "C:\\payload\\backend\\jw", "workswarm0.2.6"],
  });
  // The runtime verify (scripts/jiuwenswarm.mjs verifyCompatibilityPatches)
  // passes only <script> verify <src> <tag> — the patch set resolves relative
  // to the script's own location. An extra --patch-dir here would be a second
  // place the payload layout is written down and a second thing to keep in step.
  assert.equal(command.args.includes("--patch-dir"), false);
});

test("patchVerifyCommand returns null without a tag (caller must fail, not skip)", () => {
  assert.equal(patchVerifyCommand({ jwPython: "p", swarmPatchesPy: "s", jwPayloadDir: "j", tag: null }), null);
  assert.equal(patchVerifyCommand({ jwPython: "p", swarmPatchesPy: "s", jwPayloadDir: "j", tag: "" }), null);
});

test("patchVerifyFailureDetail names the refresh command and carries the verifier tail", () => {
  const detail = patchVerifyFailureDetail({
    jwPayloadDir: "C:\\out\\backend\\jw",
    tag: "workswarm0.2.6",
    exitCode: 1,
    stderr: [
      "Traceback (most recent call last):",
      '  File "D:\\build\\scripts\\swarm-patches.py", line 188, in <module>',
      "    process(args.mode, args.target, args.tag, args.patch_dir)",
      '  File "D:\\build\\scripts\\swarm-patches.py", line 178, in process',
      "    raise ValueError(\"Swarm patch verification failed; rebuild or run setup before starting\")",
      "ValueError: Swarm patch verification failed; rebuild or run setup before starting",
    ].join("\n"),
  });
  assert.match(detail, /exit 1/);
  assert.match(detail, /workswarm0\.2\.6/);
  assert.match(detail, /node scripts\/jiuwenswarm\.mjs setup/);
  // The ValueError (the reason the verify died) survives the bounded tail…
  assert.match(detail, /Swarm patch verification failed/);
  // …but the traceback's upper context lines do not: only the last 4 lines ride along.
  assert.equal(detail.includes("Traceback (most recent call last)"), false);
  assert.equal(detail.includes("line 188"), false);
});
