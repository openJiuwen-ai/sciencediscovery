// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

// The status line beside 启用科学记忆 used to be a mount-time snapshot
// (Issue #1384): a memory service that came back while the pane stayed open
// still read 连接失败 until the reader reloaded the page. These cases own the
// clock, so they can show the line changing on its own rather than on a press.

import React from "react";
import assert from "node:assert/strict";

import { createTest } from "../../../test/support/tagged/compat.mjs";
import type { ApiClient } from "../src/api/client.js";
import type { HealthReport } from "../src/api/models.js";
import { TEXT } from "../src/text.js";
import { MEMORY_STATUS_POLL_MS, MemoryStatus } from "../src/views/MemoryStatus.js";
import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });

/** Reads the test answers when it chooses: whether the line re-reads on its own
 *  is only visible with the clock and the service under the test's control. */
function healthStub() {
  const pending: Array<{ reject: (reason: Error) => void; resolve: (report: HealthReport) => void }> = [];
  let reads = 0;
  const client = {
    request: (path: string) => {
      assert.equal(path, "/api/health");
      reads += 1;
      return new Promise<HealthReport>((resolve, reject) => pending.push({ reject, resolve }));
    },
  } as unknown as ApiClient;
  return { client, pending, reads: () => reads };
}

function markup(view: ReactTestRenderer): string {
  const tree = view.toJSON();
  return tree === null ? "" : JSON.stringify(tree);
}

async function answer(
  stub: ReturnType<typeof healthStub>,
  report: HealthReport,
): Promise<void> {
  const next = stub.pending.shift();
  assert.ok(next, "the line should have a read waiting for an answer");
  await act(async () => next.resolve(report));
}

test("a recovered memory service reads 运行正常 without a reload or a press", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const stub = healthStub();
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<MemoryStatus client={stub.client} enabled />); });
  try {
    assert.equal(stub.reads(), 1);
    assert.ok(markup(view).includes(TEXT.memory.status.checking));

    // A read still in flight must not be joined by another one, however many
    // intervals pass while the service is slow.
    await act(async () => { context.mock.timers.tick(MEMORY_STATUS_POLL_MS * 3); });
    assert.equal(stub.reads(), 1);

    await answer(stub, { memoryGraph: "degraded" });
    assert.ok(markup(view).includes(TEXT.memory.status.degraded));
    assert.ok(!markup(view).includes(TEXT.memory.status.healthy));

    // The service recovers between two background readings. While the next one
    // is in flight the previous answer stays: a poll is not a fresh question,
    // so the word does not fall back to 检查中.
    await act(async () => { context.mock.timers.tick(MEMORY_STATUS_POLL_MS); });
    assert.equal(stub.reads(), 2);
    assert.ok(!markup(view).includes(TEXT.memory.status.checking));
    await answer(stub, { memoryGraph: "healthy" });

    // No remount, no 重新检查: the open line now reports the recovered service.
    assert.ok(markup(view).includes(TEXT.memory.status.healthy));
    assert.ok(!markup(view).includes(TEXT.memory.status.degraded));
  } finally {
    await act(async () => view.unmount());
  }

  // Unmounting takes the timer with it: the line that is gone asks nothing.
  const afterUnmount = stub.reads();
  context.mock.timers.tick(MEMORY_STATUS_POLL_MS * 4);
  assert.equal(stub.reads(), afterUnmount);
});

test("重新检查 still reads at once instead of waiting for the timer", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const stub = healthStub();
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<MemoryStatus client={stub.client} enabled />); });
  try {
    await answer(stub, { memoryGraph: "degraded" });
    const press = () => {
      const button = view.root.findAllByType("button")
        .find((node) => node.children.includes(TEXT.memory.status.recheck));
      assert.ok(button, "the recheck press should be offered beside a reading");
      (button.props.onClick as () => void)();
    };
    await act(async () => press());
    // The press reads now, without the clock moving, and shows 检查中 while it
    // waits — the same immediate re-read as before the timer existed.
    assert.equal(stub.reads(), 2);
    assert.ok(markup(view).includes(TEXT.memory.status.checking));

    // The press replaces the pending background read rather than adding a
    // second chain: exactly one read is waiting at any moment.
    assert.equal(stub.pending.length, 1);
    await answer(stub, { memoryGraph: "healthy" });
    assert.ok(markup(view).includes(TEXT.memory.status.healthy));
  } finally {
    await act(async () => view.unmount());
  }
});

test("memory off draws no line and asks the service nothing, even after intervals", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const stub = healthStub();
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<MemoryStatus client={stub.client} enabled={false} />); });
  try {
    assert.equal(markup(view), "");
    assert.equal(stub.reads(), 0);
    await act(async () => { context.mock.timers.tick(MEMORY_STATUS_POLL_MS * 4); });
    assert.equal(stub.reads(), 0);
  } finally {
    await act(async () => view.unmount());
  }
});
