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
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import type { ApiClient } from "../src/api/client.js";
import { readCachedDocument } from "../src/app/document-cache.js";

interface Call {
  path: string;
  settle: (body: string | Error) => void;
}

/** A client whose streams are answered by the test, so the order of two
 *  overlapping reads is the test's to control rather than the network's. */
function deferredClient() {
  const calls: Call[] = [];
  const client = {
    fetchStream: (path: string) => new Promise<Response>((resolve, reject) => {
      calls.push({
        path,
        settle: (body) => {
          if (body instanceof Error) reject(body);
          else resolve(new Response(body, { headers: { "content-type": "text/markdown" } }));
        },
      });
    }),
  } as unknown as ApiClient;
  return { calls, client };
}

describe("version document cache", () => {
  it("reads a version once and serves the second open from the cache", async () => {
    const { calls, client } = deferredClient();
    const first = readCachedDocument(client, "session-1", "version-1");
    calls[0]!.settle("# report");
    const document = await first;

    const second = await readCachedDocument(client, "session-1", "version-1");

    assert.equal(calls.length, 1);
    assert.equal(second, document);
    assert.equal(new TextDecoder().decode(second.bytes), "# report");
    assert.equal(second.mediaType, "text/markdown");
  });

  it("makes two callers that ask at once share one request", async () => {
    const { calls, client } = deferredClient();
    const ahead = readCachedDocument(client, "session-1", "version-1");
    const behind = readCachedDocument(client, "session-1", "version-1");
    calls[0]!.settle("bytes");

    const [first, second] = await Promise.all([ahead, behind]);

    assert.equal(calls.length, 1);
    assert.equal(first, second);
  });

  it("does not keep a failed read, so a retry asks again", async () => {
    const { calls, client } = deferredClient();
    const failed = readCachedDocument(client, "session-1", "version-1");
    calls[0]!.settle(new Error("gone"));
    await assert.rejects(failed, /gone/u);

    const retried = readCachedDocument(client, "session-1", "version-1");
    calls[1]!.settle("back");
    const document = await retried;

    assert.equal(calls.length, 2);
    assert.equal(new TextDecoder().decode(document.bytes), "back");
  });

  it("keys a version by the Session it is read through", async () => {
    const { calls, client } = deferredClient();
    const first = readCachedDocument(client, "session-1", "version-1");
    const second = readCachedDocument(client, "session-2", "version-1");
    calls[0]!.settle("one");
    calls[1]!.settle("two");
    await Promise.all([first, second]);

    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.path, "/api/sessions/session-1/artifact-versions/version-1/content");
    assert.equal(calls[1]!.path, "/api/sessions/session-2/artifact-versions/version-1/content");
  });

  it("holds nothing across two clients, so a replaced client starts empty", async () => {
    const one = deferredClient();
    const two = deferredClient();
    const first = readCachedDocument(one.client, "session-1", "version-1");
    one.calls[0]!.settle("one");
    await first;

    const again = readCachedDocument(two.client, "session-1", "version-1");
    two.calls[0]!.settle("two");
    const document = await again;

    assert.equal(two.calls.length, 1);
    assert.equal(new TextDecoder().decode(document.bytes), "two");
  });

  it("serves a document too large to keep without holding it", async () => {
    const { calls, client } = deferredClient();
    const huge = "x".repeat(4 * 1024 * 1024 + 1);
    const first = readCachedDocument(client, "session-1", "version-1");
    calls[0]!.settle(huge);
    const document = await first;
    assert.equal(document.bytes.byteLength, huge.length);

    const second = readCachedDocument(client, "session-1", "version-1");
    calls[1]!.settle("small");
    await second;

    assert.equal(calls.length, 2);
  });
});
