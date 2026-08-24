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

/**
 * What the probe hands down.
 *
 * The design is "probe once, on this side, and send the answer": the container
 * corrections have one owner, and asking twice in two languages is how two
 * answers start to disagree. That only holds if what is sent identifies the
 * binary that was tested — a bare name is resolved *again* on the other side,
 * against a different PATH.
 */

import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { platform } from "node:process";
import { resolve } from "node:path";
import { test } from "node:test";

import { probeEvolveSandbox, toSidecarCapability } from "./sandbox.js";

test("the probe names the binary it probed, not a name to look up again", async (t) => {
  if (platform === "darwin") {
    // Seatbelt ships with the system; there is no binary to disambiguate.
    return t.skip("bwrap resolution is a Linux concern");
  }
  const directory = await mkdtemp(resolve(tmpdir(), "bwrap-probe-"));
  const fake = resolve(directory, "bwrap");
  // Exits non-zero, so the probe reports "unusable" — which is fine: this is
  // about *which path* comes back, not about the verdict.
  await writeFile(fake, "#!/bin/sh\nexit 1\n", "utf-8");
  await chmod(fake, 0o755);

  const previous = process.env.PATH;
  process.env.PATH = directory;
  try {
    const capability = await probeEvolveSandbox("bwrap");
    // Absolute. A host with two bubblewraps — a new one in /usr/local/bin, the
    // distro's older one in /usr/bin — otherwise gets probed on one and
    // confines candidates with the other, and the older one has no
    // `--clearenv`. That happened on a real deployment, where it surfaced as
    // "the baseline program will not run".
    assert.equal(capability.bwrapPath, fake);
    assert.equal(toSidecarCapability(capability).bwrap_path, fake);
  } finally {
    process.env.PATH = previous;
  }
});

test("a configured absolute path is passed through untouched", async () => {
  const capability = await probeEvolveSandbox("/opt/custom/bwrap");
  assert.equal(capability.bwrapPath, "/opt/custom/bwrap");
});
