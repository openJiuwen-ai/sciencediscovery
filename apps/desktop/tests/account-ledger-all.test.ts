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
  tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import { listAccountLedgerAll } from "../src/auth/account.js";

function row(id: number) {
  return {
    id,
    delta: 10,
    deltaCredits: 0.01,
    balanceAfter: 1000,
    balanceAfterCredits: 1,
    bizType: "CHECKIN",
    bizId: String(id),
    remark: null,
    createdAt: "2026-11-27T00:00:00.000Z",
  };
}

test("a service that supports all=1 is read once", async () => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ items: [row(2), row(1)], nextBeforeId: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const page = await listAccountLedgerAll("token");
    assert.deepEqual(page.items.map((item) => item.id), [2, 1]);
    assert.equal(page.nextBeforeId, null);
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /all=1/u);
  } finally {
    globalThis.fetch = original;
  }
});

test("an older service that ignores all=1 is walked by cursor", async () => {
  const urls: string[] = [];
  const replies = [
    { items: [row(5), row(4)], nextBeforeId: 4 },
    { items: [row(3), row(2)], nextBeforeId: 2 },
    { items: [row(1)], nextBeforeId: null },
  ];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify(replies.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const page = await listAccountLedgerAll("token");
    assert.deepEqual(page.items.map((item) => item.id), [5, 4, 3, 2, 1]);
    assert.equal(page.nextBeforeId, null);
    assert.equal(urls.length, 3);
    assert.match(urls[0]!, /all=1/u);
    assert.match(urls[1]!, /limit=100&beforeId=4/u);
  } finally {
    globalThis.fetch = original;
  }
});
