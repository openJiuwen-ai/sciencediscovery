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

// Issue #1352: a memory service that answers `/health` but refuses every
// authenticated query must not read as "Running normally", and the citation
// card must say the credentials were rejected instead of "the service did not
// answer". The status line is mounted and its text asserted; the card's
// reason→copy mapping is asserted directly, because the card portals into a
// DOM this test environment does not have.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import React from "react";

import { setLanguage, TEXT } from "../src/text.js";
import { memoryCardFailure } from "../src/views/MemoryCardDialog.js";
import { MemoryStatus } from "../src/views/MemoryStatus.js";
import { StubClient } from "./api-stub.js";
import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

function rendered(view: ReactTestRenderer): string {
  return JSON.stringify(view.toJSON());
}

describe("the scientific-memory status line", () => {
  it("shows a rejected credential instead of running normally", async () => {
    setLanguage("zh-CN");
    const stub = new StubClient().reply({ liveness: "ok", memoryGraph: "unauthorized", status: "ok" });
    let view!: ReactTestRenderer;
    await act(async () => { view = create(<MemoryStatus client={stub.asClient()} enabled />); });
    try {
      await flush();
      const html = rendered(view);
      assert.ok(html.includes(TEXT.memory.status.unauthorized));
      assert.ok(!html.includes(TEXT.memory.status.healthy), "a refused query must never read as healthy");
      assert.match(html, /memory-status is-unauthorized/);
      assert.equal(stub.calls[0]!.path, "/api/health");
    } finally {
      await act(async () => view.unmount());
    }
  });

  it("still says running normally when the service accepts the query path", async () => {
    setLanguage("zh-CN");
    const stub = new StubClient().reply({ liveness: "ok", memoryGraph: "healthy", status: "ok" });
    let view!: ReactTestRenderer;
    await act(async () => { view = create(<MemoryStatus client={stub.asClient()} enabled />); });
    try {
      await flush();
      assert.ok(rendered(view).includes(TEXT.memory.status.healthy));
    } finally {
      await act(async () => view.unmount());
    }
  });
});

describe("the citation card's reason mapping", () => {
  it("gives a 401 its own copy instead of the timeout copy", () => {
    setLanguage("zh-CN");
    const rejected = memoryCardFailure("memory_graph_unauthorized");
    assert.ok(rejected);
    assert.equal(rejected.title, TEXT.memory.authTitle);
    assert.equal(rejected.message, TEXT.memory.authBody);
    assert.equal(rejected.recovery, "settings", "retrying the same token cannot help");
    assert.notEqual(rejected.message, TEXT.memory.unreachableBody);
  });

  it("keeps a transport failure on the unreachable copy, so the two differ", () => {
    setLanguage("zh-CN");
    const unreachable = memoryCardFailure("memory_graph_unreachable");
    assert.ok(unreachable);
    assert.equal(unreachable.title, TEXT.memory.unreachableTitle);
    assert.equal(unreachable.message, TEXT.memory.unreachableBody);
    assert.equal(unreachable.recovery, "retry");
    assert.notEqual(unreachable.message, TEXT.memory.authBody);
  });

  it("keeps the budget refusal retryable and the off switch pointing at settings", () => {
    setLanguage("zh-CN");
    assert.equal(memoryCardFailure("memory_graph_query_limit")?.recovery, "retry");
    assert.equal(memoryCardFailure("memory_graph_disabled")?.message, TEXT.memory.disabledBody);
    assert.equal(memoryCardFailure("node_not_found"), undefined, "an absent node is not a failed read");
    assert.equal(memoryCardFailure(undefined), undefined);
  });

  it("carries the same split into both dictionaries", () => {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguage(language);
      const rejected = memoryCardFailure("memory_graph_unauthorized");
      const unreachable = memoryCardFailure("memory_graph_unreachable");
      assert.ok(rejected);
      assert.ok(unreachable);
      assert.notEqual(rejected.message, unreachable.message, language);
      assert.match(rejected.message, /内部令牌|internal token/, language);
      assert.notEqual(TEXT.memory.status.unauthorized, TEXT.memory.status.healthy, language);
    }
    setLanguage("zh-CN");
  });
});
