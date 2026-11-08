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

import { ApiRequestError } from "../src/api/client.js";
import type { CopyOperation } from "../src/api/research-package.js";
import { copyPollStep } from "../src/views/research-package-copy-poll.js";

const t = { copyMissing: "复制任务对应的会话或操作记录已不存在，已停止等待。", copyPollingFailed: "暂时无法读取复制进度，已停止重试。" };
const copying = (): CopyOperation => ({ id: "op-1", sourceSessionId: "src", state: "copying", createdAt: "now" } as CopyOperation);
const ready = (): CopyOperation => ({ id: "op-1", sourceSessionId: "src", state: "ready", entrySessionId: "entry", createdAt: "now" } as CopyOperation);

test("a successful poll keeps a copying task polling and clears any transient state", () => {
  const step = copyPollStep(copying(), 2, { ok: true, copy: copying() }, t);
  assert.equal(step.failures, 0);
  assert.equal(step.error, "");
  assert.equal(step.terminate, false);
  assert.equal(step.copy?.state, "copying");
});

test("a successful poll that reports ready stops the poll", () => {
  const step = copyPollStep(copying(), 1, { ok: true, copy: ready() }, t);
  assert.equal(step.terminate, true);
  assert.equal(step.copy?.state, "ready");
});

test("a 404 clears the stale copy and stops with the localized missing message", () => {
  const step = copyPollStep(copying(), 0, { ok: false, reason: new ApiRequestError("missing", 404) }, t);
  assert.equal(step.terminate, true);
  assert.equal(step.error, t.copyMissing);
  assert.equal(step.copy, undefined);
});

test("a transient failure inside the bound retries silently", () => {
  const step = copyPollStep(copying(), 2, { ok: false, reason: new Error("boom") }, t);
  assert.equal(step.terminate, false);
  assert.equal(step.failures, 3);
  assert.equal(step.error, "");
  assert.equal(step.copy?.state, "copying");
});

test("the fifth transient failure clears the copy and stops with the terminal message", () => {
  const step = copyPollStep(copying(), 4, { ok: false, reason: new Error("boom") }, t);
  assert.equal(step.terminate, true);
  assert.equal(step.failures, 5);
  assert.equal(step.error, t.copyPollingFailed);
  assert.equal(step.copy, undefined);
});