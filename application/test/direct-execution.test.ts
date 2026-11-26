import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIRECT_EXECUTION_FILE,
  parseDirectExecutionFlag,
  readDirectExecution,
  renderDirectExecutionFlag,
  writeDirectExecution,
} from "../src/direct-execution.ts";

// --- pure parse/render ---------------------------------------------------------

test("parse: only an exact \"1\" is opted-in; anything else reads OFF", () => {
  assert.equal(parseDirectExecutionFlag("1"), true);
  // Every malformed, truncated or hand-edited shape must read as OFF — the
  // sandboxed default never depends on the file being readable.
  for (const raw of ["", " ", "true", "yes", "0", "1 ", " 1", "on", "11", "1\nextra"]) {
    assert.equal(parseDirectExecutionFlag(raw), false, `expected OFF for ${JSON.stringify(raw)}`);
  }
  assert.equal(parseDirectExecutionFlag(null), false);
});

test("render round-trips with parse", () => {
  assert.equal(parseDirectExecutionFlag(renderDirectExecutionFlag(true)), true);
  assert.equal(parseDirectExecutionFlag(renderDirectExecutionFlag(false)), false);
});

// --- file IO (the shell-locale precedent: one tiny file, best-effort) ----------

test("read: missing file = OFF (fail-closed default)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "direct-exec-"));
  assert.equal(readDirectExecution(dir), false);
});

test("write then read round-trips; the reply is the re-read truth", async () => {
  const dir = await mkdtemp(join(tmpdir(), "direct-exec-"));
  assert.equal(writeDirectExecution(dir, true), true, "the reply must be the persisted state");
  assert.equal(readDirectExecution(dir), true);
  const raw = await readFile(join(dir, DIRECT_EXECUTION_FILE), "utf8");
  assert.equal(raw, "1");
  assert.equal(writeDirectExecution(dir, false), false);
  assert.equal(readDirectExecution(dir), false);
});

test("a corrupted file still reads OFF, and a fresh write repairs it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "direct-exec-"));
  await writeFile(join(dir, DIRECT_EXECUTION_FILE), "true-ish garbage", "utf8");
  assert.equal(readDirectExecution(dir), false, "corruption must never read as opted-in");
  assert.equal(writeDirectExecution(dir, true), true);
  assert.equal(readDirectExecution(dir), true);
});

// --- [mac-direct] the installation-level opt-in state --------------------------
// The settings switch writes this state; the session probe-failure flag
// ([U5]) is its second consumer (darwinDirectEnv / the wizard self-check).
// The write's re-read semantics stay load-bearing: whoever reads the state
// next boot (or next spawn) must be able to trust a single persisted byte.

test("the opt-in write persists a state the next boot's gate reads as opted-in", async () => {
  const dir = await mkdtemp(join(tmpdir(), "direct-exec-u4-"));
  // The exact sequence every writer follows: write true, then re-read before
  // trusting it.
  writeDirectExecution(dir, true);
  const persisted = readDirectExecution(dir);
  assert.equal(persisted, true, "consumers must be able to rely on the re-read, not the write's return");
  // And the file holds the exact byte shape parse expects — a truncated or
  // alien write must never read as opted-in.
  const raw = await readFile(join(dir, DIRECT_EXECUTION_FILE), "utf8");
  assert.equal(parseDirectExecutionFlag(raw), true);
});

test("a failed write (unpersisted state) must read OFF so no consumer trusts it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "direct-exec-u4-bad-"));
  // Simulate the failure mode: the write did not land (e.g. the userData dir
  // vanished under us). Whatever the caller was told, the re-read is what
  // gates every consumer — OFF here means the switch stays effectively off
  // until a retry repairs the file.
  await writeFile(join(dir, DIRECT_EXECUTION_FILE), "garbage", "utf8");
  assert.equal(readDirectExecution(dir), false, "a non-'1' file must never read as opted-in");
  assert.equal(writeDirectExecution(dir, true), true, "a retry after the failure is still repairable");
});
