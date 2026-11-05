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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import { replaceFile } from "./atomic-file.js";

function refusal(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

const noWait = async () => {};

test("a rename Windows refused while another handle held the file is retried", async () => {
  // What a virus scanner does to a freshly written temp file: it takes a
  // handle for a few milliseconds and `MoveFileEx` answers EPERM. The write
  // must survive that, not fail the run that asked for it.
  let attempts = 0;
  await replaceFile("run.tmp", "run.json", {
    rename: async () => {
      attempts += 1;
      if (attempts < 3) throw refusal("EPERM");
    },
    sleep: noWait,
  });
  assert.equal(attempts, 3);
});

test("a failure that will not pass is reported at once, not retried", async () => {
  // Retrying a full disk only makes the caller wait a second for the same
  // answer, and the error is the thing a person needs to see.
  let attempts = 0;
  await assert.rejects(
    replaceFile("run.tmp", "run.json", {
      rename: async () => {
        attempts += 1;
        throw refusal("ENOSPC");
      },
      sleep: noWait,
    }),
    /ENOSPC/,
  );
  assert.equal(attempts, 1);
});

test("a target that never lets go fails after the attempts run out", async () => {
  let attempts = 0;
  await assert.rejects(
    replaceFile("run.tmp", "run.json", {
      rename: async () => {
        attempts += 1;
        throw refusal("EPERM");
      },
      sleep: noWait,
    }),
    /EPERM/,
  );
  // One try plus the ten retries the helper allows: bounded, so a permanently
  // locked file surfaces instead of hanging the writer.
  assert.equal(attempts, 11);
});
