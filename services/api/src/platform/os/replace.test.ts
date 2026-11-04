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

import { createTest } from "../../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { FileReplaceError, replaceFile } from "./replace.js";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: rename`), { code });
}

test("a transient sharing violation is retried until the replace succeeds", async () => {
  const calls: string[] = [];
  let attempt = 0;
  await replaceFile("staging.tmp", "state.json", {
    attempts: 5,
    delayMs: () => 0,
    renameFile: async (source, destination) => {
      calls.push(`${source}->${destination}`);
      attempt += 1;
      if (attempt <= 2) throw errno("EPERM");
    },
  });
  assert.equal(calls.length, 3, "two failures and then the successful replace");
  assert.deepEqual(calls, Array.from({ length: 3 }, () => "staging.tmp->state.json"));
});

test("every transient errno is retried", async () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    let attempt = 0;
    await replaceFile("staging.tmp", "state.json", {
      attempts: 3,
      delayMs: () => 0,
      renameFile: async () => {
        attempt += 1;
        if (attempt === 1) throw errno(code);
      },
    });
    assert.equal(attempt, 2, `${code} must be retried`);
  }
});

test("a persistent sharing violation is classified after the last attempt", async () => {
  let attempt = 0;
  await assert.rejects(
    replaceFile("staging.tmp", "session-runs/session.json", {
      attempts: 3,
      delayMs: () => 0,
      renameFile: async () => {
        attempt += 1;
        throw errno("EPERM");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof FileReplaceError);
      assert.equal(error.code, "EPERM", "the errno stays classifiable");
      assert.equal(error.attempts, 3);
      assert.equal(error.destination, "session-runs/session.json");
      assert.match(error.message, /after 3 attempts \(EPERM\)/);
      assert.equal((error.cause as NodeJS.ErrnoException).code, "EPERM", "the last failure is kept as the cause");
      return true;
    },
  );
  assert.equal(attempt, 3, "a persistent lock is not retried forever");
});

test("a non-transient failure is thrown at once instead of retried", async () => {
  let attempt = 0;
  await assert.rejects(
    replaceFile("staging.tmp", "state.json", {
      attempts: 5,
      delayMs: () => 0,
      renameFile: async () => {
        attempt += 1;
        throw errno("ENOSPC");
      },
    }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOSPC",
  );
  assert.equal(attempt, 1, "a full disk cannot heal by waiting");
});
