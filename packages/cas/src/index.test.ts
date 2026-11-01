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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";


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

test("a corrupt pool copy falls back to the intact legacy layout", async () => {
  await withStore(async (store, root) => {
    const bytes = Buffer.from("recoverable scientific artifact");
    const object = await store.put(bytes);

    // An older writer left the intact copy in the legacy bare-hash layout.
    const legacy = resolve(root, "cas", "sha256", object.hash.slice(0, 2), object.hash);
    await mkdir(resolve(legacy, ".."), { recursive: true });
    await writeFile(legacy, bytes);
    // The copy this store reads first was corrupted in place.
    await writeFile(resolve(root, "versioning", "agent-state", "blobs", "sha256", object.hash), "corrupted pool copy");

    assert.deepEqual(await store.read(object.hash), bytes);
    // The fallback must leave the two public predicates right for this layout
    // too: has() used to throw and verify() to answer false, and a later
    // cleanup of has() (see #680) must not undo half of it unnoticed.
    assert.equal(await store.has(object.hash), true);
    assert.equal(await store.verify(object.hash), true);
  });
});

test("the other pool's layout is a fallback candidate too", async () => {
  await withStore(async (store, root) => {
    const bytes = Buffer.from("artifact only the other pool kept intact");
    const object = await store.put(bytes);

    // This store reads its own pool first; that copy is corrupt, the legacy
    // layout is absent, and only versioning/data still holds the real bytes.
    await writeFile(resolve(root, "versioning", "agent-state", "blobs", "sha256", object.hash), "corrupted pool copy");
    const otherPool = resolve(root, "versioning", "data", "blobs", "sha256", object.hash);
    await mkdir(resolve(otherPool, ".."), { recursive: true });
    await writeFile(otherPool, bytes);

    assert.deepEqual(await store.read(object.hash), bytes);
  });
});

test("a non-ENOENT filesystem failure is not reported as corruption", async () => {
  await withStore(async (store, root) => {
    const bytes = Buffer.from("artifact behind an unreadable path");
    const object = await store.put(bytes);

    // A directory where the blob should be makes readFile fail with EISDIR:
    // that is an I/O error, not a corrupt copy, so it must surface as-is.
    await rm(resolve(root, "versioning", "agent-state", "blobs", "sha256", object.hash));
    await mkdir(resolve(root, "versioning", "agent-state", "blobs", "sha256", object.hash), { recursive: true });

    await assert.rejects(store.read(object.hash), (error: NodeJS.ErrnoException) => {
      assert.notEqual(error.code, "ENOENT");
      assert.notEqual(error.message, "CAS integrity failure");
      return true;
    });
  });
});

test("every copy corrupt still reports corruption, not a missing object", async () => {
  await withStore(async (store, root) => {
    const bytes = Buffer.from("recoverable scientific artifact");
    const object = await store.put(bytes);

    const legacy = resolve(root, "cas", "sha256", object.hash.slice(0, 2), object.hash);
    await mkdir(resolve(legacy, ".."), { recursive: true });
    await writeFile(legacy, "corrupted legacy copy");
    await writeFile(resolve(root, "versioning", "agent-state", "blobs", "sha256", object.hash), "corrupted pool copy");

    await assert.rejects(store.read(object.hash), /CAS integrity failure/);
  });
});

test("a hash that was never stored keeps the ENOENT shape", async () => {
  await withStore(async (store) => {
    await assert.rejects(store.read("0".repeat(64)), (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "ENOENT");
      assert.equal(error.message, "CAS object not found");
      return true;
    });
  });
});
