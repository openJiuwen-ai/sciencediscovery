// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkoutGitSkillRepository } from "./skills.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/**
 * A `git` on PATH that records every command it was given and answers like the
 * transport does in `mode`. The clone is this module's only network step, so a
 * script is what a stalled, refused, or missing remote looks like from here.
 */
async function fakeGit(mode: "flaky" | "broken" | "nofilter" | "missing" | "checkoutflaky" | "slowonce") {
  const directory = await mkdtemp(resolve(tmpdir(), "git-checkout-"));
  const script = resolve(directory, "git");
  await writeFile(script, `#!/bin/sh
printf '%s\\n' "$*" >> "$GIT_SHIM_LOG"
last=''
for arg do last=$arg; done
case "$*" in
  *"rev-parse HEAD"*)
    printf '%s\\n' "$GIT_SHIM_COMMIT"
    exit 0;;
esac
case " $* " in
  *" sparse-checkout "*) ;;
  *" checkout"*)
    if [ "$GIT_SHIM_MODE" = "checkoutflaky" ] && [ ! -e "$GIT_SHIM_LOG.checkout" ]; then
      : > "$GIT_SHIM_LOG.checkout"
      echo "fatal: early EOF" >&2
      exit 128
    fi;;
esac
case " $* " in
  *" clone "*)
    case " $* " in
      *"--filter="*)
        if [ "$GIT_SHIM_MODE" = "nofilter" ]; then
          echo "fatal: filtering not recognized by server" >&2
          exit 128
        fi
        if [ "$GIT_SHIM_MODE" = "broken" ]; then
          echo "fatal: RPC failed; curl 56 OpenSSL SSL_read: Connection reset by peer" >&2
          exit 128
        fi
        if [ "$GIT_SHIM_MODE" = "slowonce" ] && [ ! -e "$GIT_SHIM_LOG.once" ]; then
          : > "$GIT_SHIM_LOG.once"
          sleep 1
          exit 0
        fi
        if [ "$GIT_SHIM_MODE" = "flaky" ] && [ ! -e "$GIT_SHIM_LOG.once" ]; then
          : > "$GIT_SHIM_LOG.once"
          echo "fatal: the remote end hung up unexpectedly" >&2
          echo "fatal: early EOF" >&2
          exit 128
        fi
        ;;
    esac
    if [ "$GIT_SHIM_MODE" = "missing" ]; then
      echo "fatal: repository 'https://example.com/skills.git/' not found" >&2
      exit 128
    fi
    mkdir -p "$last"
    ;;
esac
exit 0
`, "utf-8");
  await chmod(script, 0o755);
  const log = resolve(directory, "commands.log");
  process.env.GIT_SHIM_LOG = log;
  process.env.GIT_SHIM_MODE = mode;
  process.env.GIT_SHIM_COMMIT = COMMIT;
  const previous = process.env.PATH;
  process.env.PATH = `${directory}:${previous ?? ""}`;
  return {
    importRoot: resolve(directory, "imports"),
    commands: async () => (await readFile(log, "utf-8").catch(() => "")).split("\n").filter(Boolean),
    restore: async () => {
      process.env.PATH = previous;
      delete process.env.GIT_SHIM_LOG;
      delete process.env.GIT_SHIM_MODE;
      delete process.env.GIT_SHIM_COMMIT;
      await rm(directory, { force: true, recursive: true });
    },
  };
}

test("a broken transfer retries the same clone instead of downloading every blob", async () => {
  const shim = await fakeGit("flaky");
  try {
    const result = await checkoutGitSkillRepository(shim.importRoot, { repositoryUrl: "https://example.com/skills.git" });
    assert.equal(result.partial, true);
    assert.equal(result.commit, COMMIT);
    const clones = (await shim.commands()).filter((line) => line.includes(" clone "));
    assert.equal(clones.length, 2, "the same partial clone twice");
    assert.ok(clones.every((line) => line.includes("--filter=blob:none")));
  } finally {
    await shim.restore();
  }
});

test("a transfer that keeps failing reports the connection, not the repository", async () => {
  const shim = await fakeGit("broken");
  try {
    await assert.rejects(
      checkoutGitSkillRepository(shim.importRoot, { repositoryUrl: "https://example.com/skills.git" }),
      /lost its connection to the repository/,
    );
    const clones = (await shim.commands()).filter((line) => line.includes(" clone "));
    assert.equal(clones.length, 2, "one attempt and one retry");
  } finally {
    await shim.restore();
  }
});

test("only a server that refuses the filter justifies a full clone", async () => {
  const shim = await fakeGit("nofilter");
  try {
    const result = await checkoutGitSkillRepository(shim.importRoot, { repositoryUrl: "https://example.com/skills.git" });
    assert.equal(result.partial, false);
    const clones = (await shim.commands()).filter((line) => line.includes(" clone "));
    assert.equal(clones.length, 2);
    assert.ok(clones[0]?.includes("--filter=blob:none"));
    assert.ok(!clones[1]?.includes("--filter="), "the fallback asks for no filter");
  } finally {
    await shim.restore();
  }
});

test("a clone that never answers is attempted again before giving up", async () => {
  const shim = await fakeGit("slowonce");
  try {
    const result = await checkoutGitSkillRepository(
      shim.importRoot,
      { repositoryUrl: "https://example.com/skills.git" },
      { cloneTimeoutMs: 100 },
    );
    assert.equal(result.partial, true);
    assert.equal((await shim.commands()).filter((line) => line.includes(" clone ")).length, 2);
  } finally {
    await shim.restore();
  }
});

test("a checkout that loses its connection is fetched again", async () => {
  const shim = await fakeGit("checkoutflaky");
  try {
    const result = await checkoutGitSkillRepository(shim.importRoot, { repositoryUrl: "https://example.com/skills.git" });
    assert.equal(result.partial, true);
    const commands = await shim.commands();
    assert.equal(commands.filter((line) => line.includes(" clone ")).length, 1);
    assert.equal(commands.filter((line) => line.endsWith(" checkout")).length, 2);
  } finally {
    await shim.restore();
  }
});

test("a repository that does not exist is not cloned a second time", async () => {
  const shim = await fakeGit("missing");
  try {
    await assert.rejects(
      checkoutGitSkillRepository(shim.importRoot, { repositoryUrl: "https://example.com/skills.git" }),
      /verify the repository/,
    );
    assert.equal((await shim.commands()).filter((line) => line.includes(" clone ")).length, 1);
  } finally {
    await shim.restore();
  }
});
