// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
//
// #897 follow-up (the .mjs half): the two-half interrupt-safety fix for
// scripts/start-stack.mjs.
//
// Half A covers the paths where a signal handler DOES run (POSIX SIGTERM,
// terminal Ctrl-C): runStep must register the uv child so cleanup() can kill
// it BEFORE restoring the lockfile — the old restore-then-kill order raced
// uv's rewrite and left a dirty lock with the backup already deleted, which
// the next start then froze as the "pristine" baseline.
// Half B covers the paths where no handler ever runs (the desktop's
// taskkill /PID /T /F in win_desktop/src/stack.ts — the normal shutdown route
// for the shipped product — plus power loss and OOM): a residual
// uv.lock.stack-backup at startup must be healed back over uv.lock before the
// next sync freezes the dirt as the baseline.
//
// Reproducing a real interrupt against a top-level-await ES module needs a
// full workspace plus a fake uv and pnpm and still only samples one moment
// (the reasoning the handler-ordering test in start-stack-lock.test.mjs
// records), so this file pins the .mjs side by SHAPE assertions — plus, for
// the new heal helper, a real behavioural run of the sliced-out function in a
// child process, the same slice-and-run technique the bash-side tests use.
//
// Every test here is host-agnostic (textual assertions + a node child
// process), so the file declares all platforms: a Windows-only SKIP would be
// the L3 trap — green in the tally, dead in fact.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTest } from "../test/support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"],
});
const repo = fileURLToPath(new URL("../", import.meta.url));

function sourceLines() {
  const src = readFileSync(join(repo, "scripts/start-stack.mjs"), "utf8");
  return { src, lines: src.split("\n") };
}

test("#897 A: runStep registers its child so cleanup can kill a mid-sync uv", () => {
  const { src } = sourceLines();
  const start = src.indexOf("async function runStep(");
  assert.ok(start >= 0, "runStep is gone from scripts/start-stack.mjs");
  const fn = src.slice(start, src.indexOf("\n}\n", start));

  assert.match(fn, /children\.push\(child\)/,
    "runStep no longer registers its child; an interrupt during a mirror sync kills nothing and uv rewrites the restored lock");
  assert.match(fn, /children\.splice\(children\.indexOf\(child\), 1\)/,
    "runStep leaks exited children into the registry; cleanup() would killTree dead PIDs");
});

test("#897 A: cleanup() kills the children before restoring the lockfile", () => {
  const { src } = sourceLines();
  const start = src.indexOf("function cleanup()");
  assert.ok(start >= 0, "cleanup is gone from scripts/start-stack.mjs");
  const fn = src.slice(start, src.indexOf("\n}\n", start));

  const kill = fn.indexOf("killTree(child)");
  const restore = fn.indexOf("restoreActiveLockfile()");
  assert.ok(kill >= 0, "cleanup no longer kills the registered children");
  assert.ok(restore >= 0, "cleanup no longer restores the lockfile");
  assert.ok(kill < restore,
    `cleanup restores the lockfile (offset ${restore}) before killing the children (offset ${kill}): the still-running uv rewrites the restored lock while the backup is already gone — the exact unrecoverable state #897 A exists to remove`);

  // And it must not merely deliver SIGTERM on POSIX and return: the handler
  // calls process.exit right after cleanup(), so an async-only kill leaves the
  // same rewrite window open. The synchronous wait (with SIGKILL escalation)
  // is part of the fix, not an optimisation.
  assert.match(fn, /Atomics\.wait/,
    "cleanup's POSIX kill path no longer waits synchronously for the children to die; process.exit right after a mere SIGTERM delivery re-opens the rewrite window");
});

test("#897 B: a residual stack backup is healed before the build block runs", () => {
  const { src, lines } = sourceLines();

  // The heal helper exists.
  assert.ok(src.includes("function healResidualLockfileBackup("),
    "healResidualLockfileBackup is gone from scripts/start-stack.mjs");

  // It runs at top level before any sync can freeze the dirt as the baseline.
  const lineOf = needle => {
    const index = lines.findIndex(line => line.includes(needle));
    assert.ok(index >= 0, `${JSON.stringify(needle)} is gone from scripts/start-stack.mjs`);
    return index + 1;
  };
  // The needle "healResidualLockfileBackup(" first matches the top-level CALL
  // site only if the definition line is excluded: the definition line reads
  // "function healResidualLockfileBackup(", which also contains the needle.
  // Find the call explicitly (a line that is not the definition).
  const healCall = lines.findIndex(line => line.includes("healResidualLockfileBackup(") && !line.includes("function healResidualLockfileBackup("));
  assert.ok(healCall >= 0, "the top-level healResidualLockfileBackup call is gone from scripts/start-stack.mjs");
  const buildBlock = lineOf("if (!options.noBuild) {");
  assert.ok(healCall + 1 < buildBlock,
    `the residual-backup heal (line ${healCall + 1}) runs at or after the build block (line ${buildBlock}); the first mirror sync would copy the dirty lock over the backup first`);
});

test("#897 B: the heal helper restores a dirty lock and leaves no backup behind", () => {
  // Behavioural run of the real helper (sliced out of the launcher, the same
  // technique the bash-side tests use), against a fake workspace whose uv.lock
  // is dirty and whose backup holds the pristine content.
  const { src } = sourceLines();
  const fnStart = src.indexOf("function healResidualLockfileBackup(");
  assert.ok(fnStart >= 0, "healResidualLockfileBackup is gone from scripts/start-stack.mjs");
  let depth = 0, fnEnd = -1;
  for (let i = src.indexOf("{", fnStart); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) { fnEnd = i + 1; break; } }
  }
  assert.ok(fnEnd > fnStart, "healResidualLockfileBackup's body is not brace-balanced");
  const healFn = src.slice(fnStart, fnEnd);

  const root = mkdtempSync(join(tmpdir(), "sd-heal-"));
  try {
    writeFileSync(join(root, "uv.lock"), "REWRITTEN-BY-THE-MIRROR\n");
    writeFileSync(join(root, "uv.lock.stack-backup"), "PRISTINE\n");

    const script = [
      'import { existsSync, copyFileSync, rmSync } from "node:fs";',
      'import { join, relative } from "node:path";',
      "const repositoryRoot = process.env.SD_ROOT;",
      'const say = m => process.stderr.write(m + "\\n");',
      healFn,
      'healResidualLockfileBackup(join(repositoryRoot, "uv.lock"), join(repositoryRoot, "uv.lock.stack-backup"));',
      'healResidualLockfileBackup(join(repositoryRoot, "uv.lock"), join(repositoryRoot, "no-such-backup"));',
    ].join("\n");
    writeFileSync(join(root, "heal.mjs"), script);
    execFileSync(process.execPath, [join(root, "heal.mjs")], { env: { ...process.env, SD_ROOT: root } });

    assert.equal(readFileSync(join(root, "uv.lock"), "utf8"), "PRISTINE\n",
      "the heal left the mirror's rewrite in uv.lock");
    assert.ok(!existsSync(join(root, "uv.lock.stack-backup")),
      "the heal left the backup behind; the next sync would overwrite it with the just-restored content");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
