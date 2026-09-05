// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const packageScript = join(repositoryRoot, ".ci", "package-binary-codearts.sh");
const testRoot = join(repositoryRoot, ".tmp", "package-binary-codearts-tests");

async function fakeRepository(name) {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, `${name}-`));
  await mkdir(join(directory, ".ci"), { recursive: true });
  await writeFile(join(directory, ".ci", "package-binary-codearts.sh"), await readFile(packageScript));
  return directory;
}

// CodeArts Build exports the run's own commit variables into every step, and
// this script reads them. Inheriting them makes a fixture assert the real
// pipeline's integration SHA against its fake checkout, so the case fails for
// a reason that has nothing to do with what it tests. Blank them, then let the
// case set back exactly what it means to exercise.
const CODEARTS_BUILD_VARIABLES = ["ARTIFACT_COMMIT", "COMMIT_ID", "EXPECTED_COMMIT", "GIT_COMMIT"];

function isolatedEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const name of CODEARTS_BUILD_VARIABLES) environment[name] = "";
  return { ...environment, ...overrides };
}

test("rejects direct and traversing output paths outside the dedicated CI results tree", async () => {
  const directory = await fakeRepository("output-guard");
  try {
    const sentinel = join(directory, ".git", "sentinel");
    await mkdir(join(directory, ".git"));
    await writeFile(sentinel, "keep\n", "utf8");

    for (const output of [".git", ".ci-results/../.git"]) {
      const result = spawnSync("/bin/bash", [
        join(directory, ".ci", "package-binary-codearts.sh"),
        "--output", output,
      ], { cwd: directory, encoding: "utf8", env: isolatedEnvironment() });

      assert.equal(result.status, 2, `unexpected exit status for ${output}`);
      assert.match(result.stderr, /dedicated subdirectory below \.ci-results|must resolve below/);
      assert.equal(await readFile(sentinel, "utf8"), "keep\n");
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("preserves a provisioning failure through the build log pipeline", async () => {
  const directory = await fakeRepository("exit-status");
  try {
    const binDirectory = join(directory, "bin");
    await mkdir(binDirectory);
    await writeFile(join(binDirectory, "git"), `#!/bin/sh
case "$1" in
  rev-parse) printf '%s\n' 0000000000000000000000000000000000000000 ;;
  cat-file) exit 0 ;;
  *) exit 99 ;;
esac
`, "utf8");
    await writeFile(join(binDirectory, "bash"), `#!/bin/sh
test "$1" = .ci/provision-runner.sh || exit 99
exit 37
`, "utf8");
    await chmod(join(binDirectory, "git"), 0o755);
    await chmod(join(binDirectory, "bash"), 0o755);

    const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
    const output = ".ci-results/package";
    const result = spawnSync("/bin/bash", [
      join(directory, ".ci", "package-binary-codearts.sh"),
      "--arch", architecture,
      "--output", output,
    ], {
      cwd: directory,
      encoding: "utf8",
      env: isolatedEnvironment({
        ARTIFACT_COMMIT: "1111111111111111111111111111111111111111",
        HOME: join(directory, "home"),
        PATH: `${binDirectory}:${process.env.PATH}`,
      }),
    });

    assert.equal(result.status, 37, result.stderr);
    assert.equal(await readFile(join(directory, output, "exit-code"), "utf8"), "37\n");
    assert.match(result.stdout, /Naming artifacts for source commit: 1111111111111111111111111111111111111111/);
    assert.match(result.stdout, /packaging exited with status 37/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test.after(async () => {
  await rm(testRoot, { force: true, recursive: true });
});
