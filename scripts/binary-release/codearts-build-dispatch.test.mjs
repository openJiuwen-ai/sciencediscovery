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
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const dispatcher = join(repositoryRoot, ".ci", "codearts-build-dispatch.sh");
const binaryFetcher = join(repositoryRoot, ".ci", "fetch-verified-binary.sh");
const qemuRunnerImageFetcher = join(repositoryRoot, ".ci", "fetch-qemu-runner-image.sh");
const qemuRunnerImageChecksum = join(repositoryRoot, ".ci", "qemu-runner-image.sha256");
const qemuEmulatorFetcher = join(repositoryRoot, ".ci", "fetch-qemu-emulator.sh");
const qemuEmulatorChecksum = join(repositoryRoot, ".ci", "qemu-emulator.sha256");
const qemuLayerRunner = join(repositoryRoot, ".ci", "run-qemu-layer.sh");
const testRoot = join(repositoryRoot, ".tmp", "codearts-build-dispatch-tests");

async function workspace(name) {
  await mkdir(testRoot, { recursive: true });
  return await mkdtemp(join(testRoot, `${name}-`));
}

function dispatch(directory, overrides = {}) {
  return spawnSync("bash", [dispatcher], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      ARGS: "",
      ENVS: "",
      SH_FILE_PATH: "target.sh",
      WORKSPACE: directory,
      ...overrides,
    },
  });
}

test("passes line-oriented environment records and arguments without eval", async () => {
  const directory = await workspace("records");
  try {
    const target = join(directory, "target.sh");
    await writeFile(target, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$SAFE_VALUE" "$URL_VALUE" "$#" "$1" "$2" > result.txt
`, "utf8");
    await chmod(target, 0o755);

    const result = dispatch(directory, {
      ARGS: "first argument\n--flag=value with spaces",
      ENVS: "SAFE_VALUE=value with spaces\nURL_VALUE=https://example.test/?a=b",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      (await readFile(join(directory, "result.txt"), "utf8")).trimEnd().split("\n"),
      ["value with spaces", "https://example.test/?a=b", "2", "first argument", "--flag=value with spaces"],
    );
    assert.match(result.stdout, /Environment records: 2/);
    assert.match(result.stdout, /Argument records: 2/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects scripts that resolve outside the checkout", async () => {
  const directory = await workspace("outside");
  try {
    const checkout = join(directory, "checkout");
    await mkdir(checkout);
    await writeFile(join(directory, "outside.sh"), "exit 0\n", "utf8");

    const result = dispatch(checkout, { SH_FILE_PATH: "../outside.sh" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /resolves outside WORKSPACE/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects shell-control environment variables before executing the target", async () => {
  const directory = await workspace("blocked-env");
  try {
    await writeFile(join(directory, "target.sh"), "touch should-not-exist\n", "utf8");

    const result = dispatch(directory, { ENVS: "BASH_ENV=malicious.sh" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /BASH_ENV cannot be supplied/);
    await assert.rejects(readFile(join(directory, "should-not-exist")), { code: "ENOENT" });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("returns the invoked script's exit status", async () => {
  const directory = await workspace("exit-status");
  try {
    await writeFile(join(directory, "target.sh"), "exit 23\n", "utf8");
    const result = dispatch(directory);
    assert.equal(result.status, 23);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("verified binary fetcher reuses a matching local cache object", async () => {
  const directory = await workspace("binary-cache-hit");
  try {
    const output = join(directory, "tool.tar.xz");
    const payload = Buffer.from("verified cache object");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    await writeFile(output, payload);

    const result = spawnSync("bash", [
      binaryFetcher,
      "--cache-only",
      "--filename", "tool.tar.xz",
      "--output", output,
      "--sha256", sha256,
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /local cache hit/);
    assert.deepEqual(await readFile(output), payload);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("verified binary fetcher reports a cache-only miss without using a source", async () => {
  const directory = await workspace("binary-cache-miss");
  try {
    const result = spawnSync("bash", [
      binaryFetcher,
      "--cache-only",
      "--filename", "missing.tar.xz",
      "--output", join(directory, "missing.tar.xz"),
      "--sha256", "0".repeat(64),
    ], { encoding: "utf8" });

    assert.equal(result.status, 3, result.stderr);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("verified binary fetcher applies a configurable download time limit", async () => {
  const directory = await workspace("binary-download-timeout");
  try {
    const binDirectory = join(directory, "bin");
    const curlArguments = join(directory, "curl-arguments.txt");
    const output = join(directory, "large.img");
    const payload = Buffer.from("verified large cache object");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const fakeCurl = join(binDirectory, "curl");
    await mkdir(binDirectory);
    await writeFile(fakeCurl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$FAKE_CURL_ARGUMENTS"
output=
while (($#)); do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf 'verified large cache object' > "$output"
`, "utf8");
    await chmod(fakeCurl, 0o755);

    const result = spawnSync("bash", [
      binaryFetcher,
      "--cache-base-url", "https://cache.example.test/qemu/v1",
      "--download-max-time", "1800",
      "--filename", "large+build.img",
      "--output", output,
      "--sha256", sha256,
      "--source-url", "https://example.test/large.img",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CURL_ARGUMENTS: curlArguments,
        PATH: `${binDirectory}:${process.env.PATH}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OBS cache hit: large\+build\.img/);
    assert.doesNotMatch(result.stdout, /source download verified/);
    assert.deepEqual(await readFile(output), payload);
    const argumentsList = (await readFile(curlArguments, "utf8")).trimEnd().split("\n");
    assert.equal(argumentsList[argumentsList.indexOf("--max-time") + 1], "1800");
    assert.ok(argumentsList.includes("https://cache.example.test/qemu/v1/large%2Bbuild.img"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("prebuilt QEMU Runner image and workflow share the immutable cache contract", async () => {
  const fetcherSource = await readFile(qemuRunnerImageFetcher, "utf8");
  const checksumRecord = (await readFile(qemuRunnerImageChecksum, "utf8")).trim();
  const workflow = await readFile(
    join(repositoryRoot, ".codearts", "workflow", "codearts-pipeline.yml"),
    "utf8",
  );
  const checksumMatch = checksumRecord.match(/^([a-f0-9]{64})  ([0-9A-Za-z._+-]+)$/);

  assert.ok(checksumMatch, "QEMU Runner checksum manifest must use sha256sum format");
  assert.match(fetcherSource, /checksum_file="\$script_dir\/qemu-runner-image\.sha256"/);
  assert.match(fetcherSource, /read -r image_sha256 image_name < "\$checksum_file"/);
  assert.doesNotMatch(fetcherSource, /image_sha256=[a-f0-9]{64}/);
  assert.match(fetcherSource, /CI_QEMU_RUNNER_IMAGE_DOWNLOAD_MAX_TIME:-300/);
  assert.match(fetcherSource, /--cache-only/);
  assert.match(fetcherSource, /sciencediscovery\/cache\/qemu-runner\/v1/);
  assert.match(workflow, /ut_guest:[\s\S]*?needs: \[\][\s\S]*?SH_FILE_PATH: \.ci\/codearts-layer\.sh/);
  const layer = await readFile(join(repositoryRoot, ".ci", "codearts-layer.sh"), "utf8");
  assert.match(layer, /CI_QEMU_RUNNER_IMAGE_DOWNLOAD_MAX_TIME:-300/);
});

test("the portable QEMU emulator is downloaded, never reassembled", async () => {
  const fetcherSource = await readFile(qemuEmulatorFetcher, "utf8");
  const checksumRecord = (await readFile(qemuEmulatorChecksum, "utf8")).trim();
  const runner = await readFile(qemuLayerRunner, "utf8");

  assert.match(checksumRecord, /^[a-f0-9]{64}  [0-9A-Za-z._+-]+$/, "the manifest must use sha256sum format");
  assert.match(fetcherSource, /checksum_file="\$script_dir\/qemu-emulator\.sha256"/);
  assert.doesNotMatch(fetcherSource, /payload_sha256=[a-f0-9]{64}/);
  assert.match(fetcherSource, /--cache-only/);
  assert.match(fetcherSource, /sciencediscovery\/cache\/qemu-emulator\/v1/);
  assert.match(runner, /\.ci\/fetch-qemu-emulator\.sh/);
  // Assembling QEMU from Alpine packages cost about 166 seconds on every guest
  // job. The resource branch owns that now; a test job only downloads.
  assert.doesNotMatch(runner, /apk\.static/);
  assert.doesNotMatch(runner, /alpine_mirror/);
});

test.after(async () => {
  await rm(testRoot, { force: true, recursive: true });
});
