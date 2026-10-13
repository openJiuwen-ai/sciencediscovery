// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { ExecutionBlocks } from "./execution-blocks.js";

const input = { sessionId: "s", executionId: "main", runnerId: "local", reason: "missing sandbox", alternatives: [{ runnerId: "remote", label: "Lab" }] };
test("two operations on the same Runner have independent decisions", async () => {
  const queue = new ExecutionBlocks();
  const first = queue.wait({ ...input, operationId: "first" });
  const second = queue.wait({ ...input, operationId: "second" });
  const [one, two] = queue.list("s");
  queue.decide("s", one!.id, { action: "retry" });
  assert.deepEqual(await first, { action: "retry" });
  assert.equal(queue.list("s")[0]!.id, two!.id);
  queue.decide("s", two!.id, { action: "cancel" });
  assert.deepEqual(await second, { action: "cancel" });
});
test("concurrent pre-dispatch waits share one decision without crossing agent/session boundaries", async () => {
  const queue = new ExecutionBlocks();
  const first = queue.wait(input), second = queue.wait(input);
  const child = queue.wait({ ...input, executionId: "child" });
  const other = queue.wait({ ...input, sessionId: "other" });
  assert.equal(queue.list("s").length, 2);
  const id = queue.list("s")[0]!.id;
  assert.throws(() => queue.decide("other", id, { action: "retry" }), /expired/);
  assert.throws(() => queue.decide("s", id, { action: "switch", runnerId: "unauthorized" }), /not an offered/);
  queue.decide("s", id, { action: "retry" });
  assert.deepEqual(await Promise.all([first, second]), [{ action: "retry" }, { action: "retry" }]);
  assert.equal(queue.list("s").length, 1);
  assert.equal(queue.list("other").length, 1);
  assert.throws(() => queue.decide("s", id, { action: "retry" }), /expired/);
  queue.close();
  assert.deepEqual(await Promise.all([child, other]), [{ action: "cancel" }, { action: "cancel" }]);
});

test("run cancellation clears all shared waiters and stale browser decisions", async () => {
  const queue = new ExecutionBlocks(), controller = new AbortController();
  const waits = [queue.wait(input, controller.signal), queue.wait(input, controller.signal)];
  const id = queue.list("s")[0]!.id;
  controller.abort();
  assert.deepEqual(await Promise.all(waits), [{ action: "cancel" }, { action: "cancel" }]);
  assert.deepEqual(queue.list("s"), []);
  assert.throws(() => queue.decide("s", id, { action: "retry" }), /expired/);
  assert.throws(() => queue.wait(input, controller.signal));
});

test("reload reads a detached snapshot and an offered switch resolves only once", async () => {
  const queue = new ExecutionBlocks();
  const wait = queue.wait(input);
  const snapshot = queue.list("s");
  snapshot[0]!.alternatives.length = 0;
  queue.decide("s", snapshot[0]!.id, { action: "switch", runnerId: "remote" });
  assert.deepEqual(await wait, { action: "switch", runnerId: "remote" });
  assert.deepEqual(queue.list("s"), []);
});
