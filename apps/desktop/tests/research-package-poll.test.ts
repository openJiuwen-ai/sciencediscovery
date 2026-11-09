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
import type { ExportOperation } from "../src/api/research-package.js";
import { exportPollStep } from "../src/views/research-package-poll.js";

const t = {
  exportMissing: "导出任务已不存在，请重新导出。",
  exportPollingFailed: "暂时无法读取导出进度，已停止重试。请稍后重新导出。",
  legacyUnavailable: "本地服务暂时不可用，正在重试…",
};

const running = (): ExportOperation => ({ id: "export-1", status: "running" } as ExportOperation);
const completed = (): ExportOperation => ({ id: "export-1", status: "completed", filename: "x.sdresearch" } as ExportOperation);
const legacy = () => new ApiRequestError("legacy_unavailable", 502);

test("a successful poll clears the transient alert and keeps a queued task polling", () => {
  const step = exportPollStep("p", running(), 3, { ok: true, task: running() }, t);
  assert.equal(step.failures, 0);
  assert.equal(step.error, "");
  assert.equal(step.terminate, false);
  assert.equal(step.task.task.status, "running");
});

test("a successful poll that reports completion stops the poll", () => {
  const step = exportPollStep("p", running(), 2, { ok: true, task: completed() }, t);
  assert.equal(step.terminate, true);
  assert.equal(step.task.task.status, "completed");
});

test("a 404 settles the task as failed with the localized missing message", () => {
  const step = exportPollStep("p", running(), 0, { ok: false, reason: new ApiRequestError("missing", 404) }, t);
  assert.equal(step.terminate, true);
  assert.equal(step.error, "");
  assert.equal(step.task.task.status, "failed");
  assert.equal(step.task.task.error, t.exportMissing);
});

test("a legacy outage inside the bound keeps the task and shows the retrying message", () => {
  const step = exportPollStep("p", running(), 2, { ok: false, reason: legacy() }, t);
  assert.equal(step.terminate, false);
  assert.equal(step.failures, 3);
  assert.equal(step.error, t.legacyUnavailable);
  assert.equal(step.task.task.status, "running");
});

test("the fifth legacy outage settles the task as failed with a terminal message, not a retry claim", () => {
  const step = exportPollStep("p", running(), 4, { ok: false, reason: legacy() }, t);
  assert.equal(step.terminate, true);
  assert.equal(step.error, "");
  assert.equal(step.task.task.status, "failed");
  assert.equal(step.task.task.error, t.exportPollingFailed);
});

test("an ordinary transient failure inside the bound retries silently", () => {
  const step = exportPollStep("p", running(), 1, { ok: false, reason: new Error("boom") }, t);
  assert.equal(step.terminate, false);
  assert.equal(step.failures, 2);
  assert.equal(step.error, "");
  assert.equal(step.task.task.status, "running");
});

test("the fifth ordinary failure settles the task as failed and stops the spinner", () => {
  const step = exportPollStep("p", running(), 4, { ok: false, reason: new Error("boom") }, t);
  assert.equal(step.terminate, true);
  assert.equal(step.error, "");
  assert.equal(step.task.task.status, "failed");
  assert.equal(step.task.task.error, t.exportPollingFailed);
});
