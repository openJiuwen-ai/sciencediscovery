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
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { CasStore, sha256, sha256File } from "./index.js";

async function withStore(run: (store: CasStore, root: string) => Promise<void>): Promise<void> {
  const root = resolve(".tmp", `cas-test-${process.pid}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  try {
    await run(new CasStore(root), root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("put deduplicates content and read/verify preserve it", async () => {
  await withStore(async (store) => {
    const first = await store.put("scientific result");
    const second = await store.put(Buffer.from("scientific result"));

    assert.deepEqual(second, first);
    assert.equal((await store.read(first.hash)).toString(), "scientific result");
    assert.equal(await store.has(first.hash), true);
    assert.equal(await store.verify(first.hash), true);
  });
});

test("putFile streams bytes into the same address space", async () => {
  await withStore(async (store, root) => {
    const source = resolve(root, "source.bin");
    const bytes = Buffer.from("streamed artifact");
    await writeFile(source, bytes);

    const object = await store.putFile(source);

    assert.deepEqual(object, { hash: sha256(bytes), size: bytes.length });
    assert.equal(await sha256File(source), object.hash);
    assert.deepEqual(await store.read(object.hash), bytes);
  });
});

test("invalid hashes are rejected and missing objects do not verify", async () => {
  await withStore(async (store) => {
    await assert.rejects(store.read("../escape"), /Invalid CAS hash/);
    assert.equal(await store.verify("0".repeat(64)), false);
  });
});
