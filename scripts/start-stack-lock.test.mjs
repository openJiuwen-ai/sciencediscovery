// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
//
// The bash launcher's custom-PyPI-mirror path — the twin of the same block in
// scripts/start-stack.mjs:292-324. The .mjs side resolves its lockfile at the
// workspace root; the bash side named "$project_dir/uv.lock" instead. Since one
// root lock now resolves every member and the five per-service
// `services/<member>/uv.lock` files are gone, that cp had no source file: under
// the script's own `set -euo pipefail` a local start aborted before uv ever ran.
//
// Only users who set SCIENCE_AGENT_PYPI_INDEX — the documented mirror switch —
// hit it, and no CI job sets it, which is how it shipped. These tests run the
// real function with a fake uv, so the failure mode is reproduced rather than
// described.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTest } from "../test/support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"],
});
const repo = fileURLToPath(new URL("../", import.meta.url));

// Slice the real code out of the launcher instead of restating it here. A copy
// of the body would keep passing after the launcher itself regressed, which is
// the one outcome this file exists to prevent.
//
// The slice starts at the restore globals, not at uv_sync_project(): the
// interrupt-safety fix (F15) moved the restore into a trapped function that
// reads those globals, so slicing only the sync function would leave the tests
// running against an undefined `restore_stack_lockfile`.
function uvSyncProjectSource(source) {
  const stack = source ?? readFileSync(join(repo, "scripts/start-stack.sh"), "utf8");
  const start = stack.indexOf('stack_lockfile_target=""');
  assert.ok(start >= 0, "the mirror restore globals are gone from scripts/start-stack.sh");
  const fnStart = stack.indexOf("uv_sync_project() {", start);
  assert.ok(fnStart > start, "uv_sync_project() is gone from scripts/start-stack.sh");
  const end = stack.indexOf("\n}\n", fnStart);
  assert.ok(end > fnStart, "uv_sync_project() body is not terminated by a line holding only }");
  return stack.slice(start, end + "\n}\n".length);
}

// A workspace shaped like this repository's: one lock at the root, members
// without one, and a `uv` on PATH that behaves the way the real binary does
// under a custom index — it re-resolves and rewrites the workspace-root lock,
// found by walking up from its cwd rather than assumed to be there.
function fakeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "sd-stack-lock-"));
  mkdirSync(join(root, "services", "paper"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "uv.lock"), "PRISTINE\n");
  writeFileSync(join(root, "bin", "uv"), `#!/usr/bin/env bash
printf '%s\\n' "cwd=$PWD" "args=$*" >> "$TRACE"
d="$PWD"
while [ "$d" != "/" ]; do
  if [ -f "$d/uv.lock" ]; then
    printf 'REWRITTEN-BY-THE-MIRROR\\n' > "$d/uv.lock"
    printf '%s\\n' "rewrote=$d/uv.lock" >> "$TRACE"
    exit 0
  fi
  d="$(dirname "$d")"
done
printf '%s\\n' "rewrote=none" >> "$TRACE"
exit 0
`, { mode: 0o755 });
  return root;
}

function runHarness(root, { body, call }) {
  const env = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    SCIENCE_AGENT_PYPI_INDEX: "https://mirror.invalid/pypi/simple",
    TRACE: join(root, "trace"),
  };
  const script = [
    // The launcher's own shell options: set -e is what turned a missing
    // lockfile into a dead start, so reproducing it is not optional.
    "set -euo pipefail",
    `repository_root="${root}"`,
    body,
    call,
    "echo SURVIVED",
  ].join("\n");
  return execFileSync("bash", ["-ec", script], { cwd: root, env, encoding: "utf8" });
}

test("a custom PyPI mirror syncs through the bash launcher and leaves the root lock pristine", () => {
  const root = fakeWorkspace();
  try {
    const out = runHarness(root, {
      body: uvSyncProjectSource(),
      call: `uv_sync_project services/paper "${join(root, "envs", "paper")}" 1`,
    });
    assert.match(out, /SURVIVED/, "the mirror path aborted instead of syncing");

    const trace = readFileSync(join(root, "trace"), "utf8");
    // uv ran, and ran inside the member directory the caller named.
    assert.match(trace, /args=sync/);
    // Matched on the trailing segments, not on the whole path: Node hands back
    // `E:\tmp\...` where bash's $PWD reports `/e/tmp/...`, so an absolute-path
    // comparison differs by separator AND by drive spelling and fails on
    // Windows even when the behaviour is right.
    assert.match(trace, /^cwd=.*[\\/]services[\\/]paper$/m, `uv was not invoked from the member directory; trace was:\n${trace}`);
    // The fake uv found the root lock by walking up, and dirtied it — and it is
    // the ROOT lock, not one under the member.
    assert.match(trace, /^rewrote=.*[\\/]uv\.lock$/m);
    assert.ok(
      !/^rewrote=.*[\\/]services[\\/]/m.test(trace),
      `uv rewrote a member lockfile instead of the workspace root's; trace was:\n${trace}`,
    );

    // ...and the mirror's rewrite was rolled back, which is the whole point of
    // the backup: the working tree must not come out of a start dirtied.
    assert.equal(readFileSync(join(root, "uv.lock"), "utf8"), "PRISTINE\n");
    assert.ok(!existsSync(join(root, "uv.lock.stack-backup")), "the backup was left behind");
    assert.ok(
      !existsSync(join(root, "services", "paper", "uv.lock")),
      "a member gained a lockfile of its own; the workspace keeps exactly one",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the same harness FAILS on the pre-fix body that copied a member lockfile", () => {
  // Pins the regression rather than the fix. The assertion above is only
  // meaningful because this one is red: with the old "$project_dir/uv.lock"
  // there is nothing to copy, so set -e kills the start before uv runs. If this
  // ever passes, the harness has stopped reproducing the bug and the green test
  // next to it proves nothing.
  const root = fakeWorkspace();
  try {
    const before = uvSyncProjectSource();
    const regressed = before
      .replaceAll('"$repository_root/uv.lock"', '"$project_dir/uv.lock"')
      .replaceAll('"$repository_root/uv.lock.stack-backup"', '"$project_dir/uv.lock.stack-backup"');
    assert.notEqual(regressed, before, "the substitution did not apply; the body no longer matches");

    let failure = null;
    try {
      runHarness(root, {
        body: regressed,
        call: `uv_sync_project services/paper "${join(root, "envs", "paper")}" 1`,
      });
    } catch (error) { failure = error; }

    assert.ok(failure, "the pre-fix body survived; the harness is not reproducing the regression");
    assert.ok(!existsSync(join(root, "trace")), "uv ran even though the lockfile copy should have aborted first");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("without a mirror the launcher still passes --locked through untouched", () => {
  // The backup/restore branch is only for the mirror case. This keeps the fix
  // from widening: --locked must still be what reaches uv otherwise, or the
  // start would silently re-resolve on every run.
  const root = fakeWorkspace();
  try {
    const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, TRACE: join(root, "trace") };
    delete env.SCIENCE_AGENT_PYPI_INDEX;
    const script = [
      "set -euo pipefail",
      `repository_root="${root}"`,
      uvSyncProjectSource(),
      `uv_sync_project services/paper "${join(root, "envs", "paper")}" 1`,
    ].join("\n");
    execFileSync("bash", ["-ec", script], { cwd: root, env, encoding: "utf8" });
    assert.match(readFileSync(env.TRACE, "utf8"), /args=sync --locked/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A `uv sync` against a mirror takes tens of seconds to minutes, so an
// interrupt lands inside that window in practice. The restore used to be a
// trailing statement after the sync, which an interrupt skips outright: uv.lock
// kept mirror-resolved content, an untracked backup stayed in the repository
// root, and the NEXT run copied the dirty lock over that backup — freezing the
// dirt as the baseline even when the following sync completed normally.
function interruptibleWorkspace() {
  const root = fakeWorkspace();
  writeFileSync(join(root, "bin", "uv"), `#!/usr/bin/env bash
printf '%s\\n' "cwd=$PWD" "args=$*" >> "$TRACE"
d="$PWD"
while [ "$d" != "/" ]; do
  if [ -f "$d/uv.lock" ]; then
    printf 'REWRITTEN-BY-THE-MIRROR\\n' > "$d/uv.lock"
    printf '%s\\n' "rewrote=$d/uv.lock" >> "$TRACE"
    break
  fi
  d="$(dirname "$d")"
done
# Interrupt the launcher shell the way Ctrl-C would, then die of the same
# signal the way a foreground child in the interrupted group does. Both halves
# matter: bash defers a trapped signal until its foreground child exits, and an
# untrapped SIGINT only takes the shell down cooperatively once the child is
# itself seen to have died of SIGINT. A fake uv that exits 0 leaves the shell
# running, so the pre-fix trailing restore still executes and the harness stops
# reproducing the bug.
#
# The signal goes to the shell's own PID by name rather than to a process group:
# a group kill is not portable (Node's SIGINT emulation terminates
# unconditionally on Windows, so the trap under test would never run).
kill -INT "$HARNESS_SHELL_PID"
kill -INT $$
exit 0
`, { mode: 0o755 });
  return root;
}

function runInterruptHarness(root, body) {
  const env = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    SCIENCE_AGENT_PYPI_INDEX: "https://mirror.invalid/pypi/simple",
    TRACE: join(root, "trace"),
  };
  const script = [
    "set -euo pipefail",
    `repository_root="${root}"`,
    "export HARNESS_SHELL_PID=$$",
    body,
    `uv_sync_project services/paper "${join(root, "envs", "paper")}" 1`,
    "echo SURVIVED",
  ].join("\n");
  try {
    const out = execFileSync("bash", ["-ec", script], { cwd: root, env, encoding: "utf8" });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? null, signal: error.signal ?? null, out: error.stdout ?? "" };
  }
}

test("an interrupt during a mirror sync still restores the root lock and leaves no backup", () => {
  const root = interruptibleWorkspace();
  try {
    const result = runInterruptHarness(root, uvSyncProjectSource());

    // The start must not carry on after Ctrl-C: a trap on INT restores state but
    // does not terminate the script on its own, so the handler exits explicitly.
    // 130 is the conventional 128+SIGINT status.
    assert.notEqual(result.code, 0, `the interrupted start exited 0; output was:\n${result.out}`);
    assert.ok(!/SURVIVED/.test(result.out), "the start continued past the interrupt");

    assert.equal(
      readFileSync(join(root, "uv.lock"), "utf8"),
      "PRISTINE\n",
      "uv.lock kept the mirror's rewrite after an interrupt",
    );
    assert.ok(
      !existsSync(join(root, "uv.lock.stack-backup")),
      "the backup survived the interrupt; the next run would copy a dirty lock over it",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the same harness FAILS on the pre-fix body that restored only on the happy path", () => {
  // Mutation guard for the interrupt case, mirroring the one above for the
  // missing-lockfile case. Reverting the trap to the original trailing
  // statement must turn the previous test red; if it stays green, the harness is
  // not actually delivering the interrupt and the fix is unverified.
  const root = interruptibleWorkspace();
  try {
    const body = uvSyncProjectSource();
    const armed = `    trap restore_stack_lockfile EXIT
    trap 'interrupt_stack_lockfile INT' INT
    trap 'interrupt_stack_lockfile TERM' TERM
`;
    assert.ok(body.includes(armed), "the trap armament changed shape; update this guard");
    const regressed = body.replace(armed, "");
    assert.notEqual(regressed, body, "the trap removal did not apply");

    const result = runInterruptHarness(root, regressed);
    assert.equal(
      readFileSync(join(root, "uv.lock"), "utf8"),
      "REWRITTEN-BY-THE-MIRROR\n",
      "the pre-fix body restored anyway, so the harness is not reproducing the interrupt",
    );
    assert.ok(
      existsSync(join(root, "uv.lock.stack-backup")),
      "the pre-fix body left no backup behind, so the harness is not reproducing the interrupt",
    );
    // Deliberately not asserting a status here: whether the untrapped shell
    // exits 130 or is reported as killed depends on how bash surfaces a
    // deferred SIGINT, and neither outcome is what this guard is for. The two
    // filesystem assertions above are the reproduction; a status check would
    // only make the guard brittle.
    assert.ok(!/SURVIVED/.test(result.out), "the pre-fix body ran past the interrupt");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the .mjs twin installs its signal handlers before the mirror syncs run", () => {
  // Static ordering guard, the same technique installer-nsh.test.ts uses for the
  // A5 budget chain. This one exists because the .mjs half of the interrupt fix
  // was dead code for exactly this reason: the handlers were registered after
  // the top-level `if (!options.noBuild)` block, while all three uvSyncProject
  // calls live INSIDE that block. During the sync there was therefore no handler
  // at all, Node's default SIGINT behaviour terminated the process, and the
  // async finally never ran - the restore was unreachable precisely in the
  // window it was written to cover.
  //
  // Ordering is asserted on line numbers rather than by running the launcher:
  // reproducing a real interrupt against a top-level-await ES module needs a
  // full workspace plus a fake uv and pnpm, and would still only sample one
  // moment. The invariant that broke is textual and cheap to pin.
  const src = readFileSync(join(repo, "scripts/start-stack.mjs"), "utf8");
  const lines = src.split("\n");
  const lineOf = (needle, what) => {
    const index = lines.findIndex(line => line.includes(needle));
    assert.ok(index >= 0, `${what} is gone from scripts/start-stack.mjs: ${JSON.stringify(needle)}`);
    return index + 1;
  };

  const handlerSigint = lineOf('process.on("SIGINT"', "the SIGINT handler");
  const handlerTerm = lineOf('process.on("SIGTERM"', "the SIGTERM handler");
  const handlerExit = lineOf('process.on("exit", cleanup)', "the exit handler");
  const buildBlock = lineOf("if (!options.noBuild) {", "the top-level build block");

  const syncs = [];
  lines.forEach((line, i) => { if (line.includes("await uvSyncProject(")) syncs.push(i + 1); });
  assert.ok(syncs.length >= 1, "no uvSyncProject call sites found; the launcher changed shape");

  assert.ok(
    handlerSigint < buildBlock && handlerTerm < buildBlock && handlerExit < buildBlock,
    `signal handlers (SIGINT ${handlerSigint}, SIGTERM ${handlerTerm}, exit ${handlerExit}) are registered at or after the build block (line ${buildBlock}), so an interrupt during a mirror sync inside it is unhandled`,
  );
  for (const sync of syncs) {
    assert.ok(
      sync > handlerSigint,
      `a mirror sync at line ${sync} runs before the SIGINT handler is registered at ${handlerSigint}`,
    );
  }
});

test("the .mjs twin's finally restores through the idempotent helper, not a cleared global", () => {
  // The companion defect: the finally cleared `activeLockRestore = null` one
  // line BEFORE copying the backup back, so a signal landing in that gap made
  // cleanup() see null and skip the restore entirely. restoreActiveLockfile()
  // captures the pair and clears the global as its first step, which removes
  // that gap; being synchronous it also cannot be abandoned by the process.exit
  // the signal handlers call, the way an awaited copyFile could be.
  const src = readFileSync(join(repo, "scripts/start-stack.mjs"), "utf8");
  const start = src.indexOf("async function uvSyncProject(");
  assert.ok(start >= 0, "uvSyncProject is gone from scripts/start-stack.mjs");
  const fn = src.slice(start, src.indexOf("\n}\n", start));

  assert.match(fn, /finally \{[^}]*restoreActiveLockfile\(\);/s,
    "the finally no longer calls restoreActiveLockfile(); the clear-then-restore window is back");
  assert.ok(!/finally \{[^}]*activeLockRestore = null/s.test(fn),
    "the finally clears activeLockRestore itself again, re-opening the window where a signal finds the pair forgotten but unrestored");
  assert.ok(!/finally \{[^}]*await copyFile/s.test(fn),
    "the finally awaits copyFile again: an awaited restore can be abandoned by the process.exit a signal handler calls");
});
