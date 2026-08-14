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
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { findExecutable, missingBwrapMessage, runPreflight } from "./preflight.js";

describe("host preflight", () => {
  let workspace = "";
  let fakeBinDirectory = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "science-agent-preflight-"));
    fakeBinDirectory = join(workspace, "bin");
    await mkdir(fakeBinDirectory, { recursive: true });
    // A bwrap stand-in that always fails the sandbox probe, so preflight has
    // to warn rather than abort once the executable itself is present.
    const stub = join(fakeBinDirectory, "bwrap");
    await writeFile(stub, "#!/bin/sh\nexit 1\n");
    await chmod(stub, 0o755);
  });

  after(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  test("names the executable and how to install it when bubblewrap is absent", () => {
    const message = missingBwrapMessage("bwrap");
    assert.match(message, /bubblewrap \(bwrap\) was not found/);
    assert.match(message, /apt-get install -y bubblewrap/);
    assert.match(message, /--skip-sandbox-check/);
    // The message has to explain the omission, not just report it.
    assert.match(message, /kernel user namespaces/);
  });

  test("resolves an executable through PATH", async () => {
    assert.equal(await findExecutable("bwrap", { PATH: fakeBinDirectory }), join(fakeBinDirectory, "bwrap"));
    assert.equal(await findExecutable("bwrap", { PATH: "/nonexistent" }), undefined);
    assert.equal(await findExecutable("/nonexistent/bwrap", {}), undefined);
  });

  test("fails serve when bubblewrap is missing", async () => {
    await assert.rejects(
      runPreflight({
        bwrapPath: "bwrap",
        dataDir: join(workspace, "data-missing"),
        env: { PATH: "/nonexistent" },
        skipSandboxCheck: false,
        warn: () => {},
      }),
      /was not found on this host/,
    );
  });

  test("starts anyway with --skip-sandbox-check and says so", async () => {
    const warnings: string[] = [];
    const result = await runPreflight({
      bwrapPath: "bwrap",
      dataDir: join(workspace, "data-skipped"),
      env: { PATH: "/nonexistent" },
      skipSandboxCheck: true,
      warn: (message) => warnings.push(message),
    });
    assert.equal(result.sandboxUsable, false);
    assert.match(warnings.join("\n"), /sandboxed execution will fail/);
  });

  test("warns but continues when bubblewrap cannot build a sandbox", async () => {
    const warnings: string[] = [];
    const result = await runPreflight({
      bwrapPath: "bwrap",
      dataDir: join(workspace, "data-restricted"),
      env: { PATH: fakeBinDirectory },
      skipSandboxCheck: false,
      warn: (message) => warnings.push(message),
    });
    assert.equal(result.bwrapPath, join(fakeBinDirectory, "bwrap"));
    assert.equal(result.sandboxUsable, false);
    assert.match(warnings.join("\n"), /cannot create a sandbox/);
  });

  test("rejects a data directory it cannot write", async () => {
    const readOnly = join(workspace, "read-only");
    await mkdir(readOnly, { recursive: true });
    await chmod(readOnly, 0o500);
    try {
      await assert.rejects(
        runPreflight({
          bwrapPath: "bwrap",
          dataDir: join(readOnly, "data"),
          env: { PATH: fakeBinDirectory },
          skipSandboxCheck: true,
          warn: () => {},
        }),
        /not writable|EACCES/,
      );
    } finally {
      await chmod(readOnly, 0o700);
    }
  });
});
