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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  decodePayloadFooter,
  encodePayloadFooter,
  PAYLOAD_FOOTER_BYTES,
  readPayloadLocator,
} from "./payload-container.js";

describe("payload container footer", () => {
  let workspace = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "science-agent-container-"));
  });

  after(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  test("round-trips a locator", () => {
    const locator = { id: "0123456789abcdef0123456789abcdef", offset: 4096, size: 1024 };
    const footer = encodePayloadFooter(locator);
    assert.equal(footer.length, PAYLOAD_FOOTER_BYTES);
    assert.deepEqual(decodePayloadFooter(footer), locator);
  });

  test("rejects an id that is not sixteen bytes", () => {
    assert.throws(() => encodePayloadFooter({ id: "abcd", offset: 0, size: 1 }), /16 hex-encoded bytes/);
  });

  test("treats a file without the magic as payload-free", async () => {
    const plain = join(workspace, "plain");
    await writeFile(plain, Buffer.alloc(256, 7));
    assert.equal(await readPayloadLocator(plain), undefined);
  });

  test("reads the locator back from a container file", async () => {
    const container = join(workspace, "container");
    const head = Buffer.alloc(64, 1);
    const payload = Buffer.alloc(200, 2);
    const locator = { id: "ff".repeat(16), offset: head.length, size: payload.length };
    await writeFile(container, Buffer.concat([head, payload, encodePayloadFooter(locator)]));
    assert.deepEqual(await readPayloadLocator(container), locator);
  });

  test("rejects a container whose payload length does not reach the footer", async () => {
    const container = join(workspace, "truncated");
    const head = Buffer.alloc(64, 1);
    const payload = Buffer.alloc(200, 2);
    const footer = encodePayloadFooter({ id: "ff".repeat(16), offset: head.length, size: payload.length + 8 });
    await writeFile(container, Buffer.concat([head, payload, footer]));
    await assert.rejects(readPayloadLocator(container), /truncated or corrupt/);
  });

  test("ignores a file shorter than a footer", async () => {
    const container = join(workspace, "tiny");
    await writeFile(container, Buffer.alloc(8, 0));
    assert.equal(await readPayloadLocator(container), undefined);
  });
});
