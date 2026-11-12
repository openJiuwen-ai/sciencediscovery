// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// Regression coverage for the two ways an interrupted mirror `uv sync` used to
// leave the working tree holding mirror-resolved versions of uv.lock.
//
// The launcher is run against a fixture root (it resolves its repository root
// from its own scripts/ directory), with a fake `uv` that rewrites the lockfile
// and then keeps writing for a while. That is the window a SIGTERM used to
// survive: cleanup() restored the backup and deleted it while uv was still
// running, so uv's next write won and nothing was left to recover from.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createTest } from "../test/support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const PRISTINE = "version = 1\n# committed resolution\n";
const MIRROR = "version = 1\n# mirror resolution\n";

/** A copy of the launcher in a fixture root, so the real checkout is untouched. */
async function createLauncherRoot() {
  const root = await mkdtemp(join(tmpdir(), "sd-start-stack-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await cp(join(scriptDir, "lib"), join(root, "scripts", "lib"), { recursive: true });
  for (const name of ["start-stack.mjs", "jiuwenswarm.mjs"]) {
    await cp(join(scriptDir, name), join(root, "scripts", name));
  }
  await writeFile(join(root, "package.json"), '{"name":"fixture","private":true}\n');
  await writeFile(join(root, "uv.lock"), PRISTINE);
  const bin = join(root, "bin");
  await mkdir(bin);
  // The launcher only needs these three on PATH to clear its dependency check.
  await writeFile(join(bin, "pnpm"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "pnpm"), 0o755);
  return { bin, root };
}

function launch(root, bin, extraArgs) {
  const child = spawn(
    process.execPath,
    [join(root, "scripts", "start-stack.mjs"), "--mode", "local", "--no-jiuwenswarm", "--no-node-build", ...extraArgs],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        SCIENCE_AGENT_PYPI_INDEX: "http://mirror.invalid/simple",
        SCIENCE_DISCOVERY_DATA_DIR: join(root, ".data"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => {
    // A killed grandchild can outlive the launcher holding the write end of
    // these pipes; release our end so the test does not wait for it.
    child.stdout.destroy();
    child.stderr.destroy();
    resolve({ code, signal });
  }));
  return { child, exited, output: () => `${stdout}\n${stderr}` };
}

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a SIGTERM during a mirror sync waits for uv, then restores the lockfile", async () => {
  const { bin, root } = await createLauncherRoot();
  try {
    const uvPidFile = join(root, "uv.pid");
    // Writes the mirror resolution, tells the test its own pid, then keeps
    // running: a launcher that restores before this exits still loses.
    await writeFile(
      join(bin, "uv"),
      `#!/bin/sh\necho $$ > "${uvPidFile}"\nprintf '${MIRROR.replace(/\n/g, "\\n")}' > uv.lock\nsleep 5\n`,
    );
    await chmod(join(bin, "uv"), 0o755);

    const run = launch(root, bin, []);
    // Wait for the pid the fake uv wrote, not for the file to exist: `echo $$ >
    // file` creates and truncates the target before the shell writes the
    // number, so an existence poll can return on a zero-length file and the
    // read below would then see nothing (#1135 has the same shape at the
    // lockfile fixture).
    await waitFor(
      async () => Number((await readFile(uvPidFile, "utf8").catch(() => "")).trim()) > 0,
      "the fake uv to record its pid",
    );
    await waitFor(
      async () => (await readFile(join(root, "uv.lock"), "utf8")) === MIRROR,
      "uv to rewrite the lockfile",
    );
    const uvPid = Number((await readFile(uvPidFile, "utf8")).trim());
    assert.ok(Number.isInteger(uvPid) && uvPid > 0, `the fake uv recorded its pid, got ${uvPidFile}`);

    run.child.kill("SIGTERM");
    const { code } = await run.exited;

    assert.equal(code, 143, `an interrupt exits with 143, not ${code}: ${run.output()}`);
    assert.equal(await readFile(join(root, "uv.lock"), "utf8"), PRISTINE,
      "the committed resolution is what the tree keeps, not the mirror's");
    assert.equal(existsSync(join(root, "uv.lock.stack-backup")), false,
      "a restored backup must not stay behind as a stray file");
    assert.equal(isAlive(uvPid), false, "the uv child is stopped before the launcher exits");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a leftover backup from a hard kill is restored on the next start", async () => {
  const { bin, root } = await createLauncherRoot();
  try {
    // A `taskkill /F` runs no handler: the tree keeps whatever uv wrote plus the
    // pristine backup. Entry is the only place that can undo it.
    await writeFile(join(root, "uv.lock"), MIRROR);
    await writeFile(join(root, "uv.lock.stack-backup"), PRISTINE);
    const seenFile = join(root, "uv-seen-lock.txt");
    // The fake uv publishes the copy under a temporary name and renames it into
    // place, so the path the test polls only ever exists complete: a shell
    // `>` redirection truncates the target before `cat` writes it, and the
    // window where that file exists at length 0 is what made this case fail
    // intermittently (#1135).
    await writeFile(
      join(bin, "uv"),
      `#!/bin/sh\ncat uv.lock > "${seenFile}.tmp"\nmv "${seenFile}.tmp" "${seenFile}"\nexit 0\n`,
    );
    await chmod(join(bin, "uv"), 0o755);

    const run = launch(root, bin, []);
    // Content, not existence: the poll and the assertion below must agree on
    // what "the sync ran" means.
    await waitFor(
      async () => (await readFile(seenFile, "utf8").catch(() => "")) === PRISTINE,
      "the first sync to read the restored lockfile",
    );
    assert.equal(await readFile(seenFile, "utf8"), PRISTINE,
      "the recovery happens before the first sync, so uv never resolves against the mirror content");
    assert.match(run.output(), /restored uv\.lock from a sync that a previous run did not finish/);

    // The run then fails on the missing Python environment, which is fine: the
    // recovery is what this case covers.
    await run.exited;
    assert.equal(existsSync(join(root, "uv.lock.stack-backup")), false);
    assert.equal(await readFile(join(root, "uv.lock"), "utf8"), PRISTINE);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
