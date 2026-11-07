// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { en, zhCN, type MessageKey } from "../src/i18n/messages.js";
import { translate } from "../src/i18n/locale.js";
import { queuedCancelToast } from "../src/run-stream/model.js";

/** Records every key the toast asks for, so the test can tell a catalog lookup from a
 * hardcoded sentence; unknown keys echo themselves like a real miss would. */
function recorder(): { asked: string[]; t: (key: MessageKey, variables?: Record<string, string | number>) => string } {
  const asked: string[] = [];
  return { asked, t: (key, variables) => { asked.push(key); return translate("zh-CN", key, variables); } };
}

test("every queued-cancel outcome is a message-catalog lookup", () => {
  const outcomes = ["cancelled", "running", "completed", "failed", "whatever"] as const;
  for (const status of outcomes) {
    const { asked, t } = recorder();
    const toast = queuedCancelToast(status, t);
    assert.ok(asked.length > 0, `${status}: the toast must be translated, not hardcoded`);
    assert.ok(asked.every((key) => key.startsWith("app.queuedCancelOutcome")),
      `${status}: every string comes from app.queuedCancelOutcome.*, got ${asked.join(", ")}`);
    assert.ok(toast.title.length > 0);
  }
});

test("a Chinese reader gets the cancel outcome in Chinese, including the Stop reference", () => {
  const cancelled = queuedCancelToast("cancelled", (key, variables) => translate("zh-CN", key, variables));
  assert.match(cancelled.title, /取消/);
  const started = queuedCancelToast("running", (key, variables) => translate("zh-CN", key, variables));
  assert.match(started.title, /已经/);
  assert.match(started.detail ?? "", /停止/);
  assert.doesNotMatch(`${started.title} ${started.detail}`, /Stop|Queued run/);
});

test("the catalog carries the six outcome strings in both locales", () => {
  for (const key of ["app.queuedCancelOutcome.cancelled", "app.queuedCancelOutcome.started",
    "app.queuedCancelOutcome.startedDetail", "app.queuedCancelOutcome.finished",
    "app.queuedCancelOutcome.updated", "app.queuedCancelOutcome.statusDetail"] as const) {
    assert.equal(typeof en[key], "string", `${key} missing from en`);
    assert.equal(typeof zhCN[key], "string", `${key} missing from zhCN`);
    assert.notEqual(zhCN[key], en[key], `${key} is not translated in zhCN`);
  }
});

test("an unexpected status keeps the status it reports", () => {
  const toast = queuedCancelToast("interrupted", (key, variables) => translate("zh-CN", key, variables));
  assert.match(toast.title, /更新|结束/);
  assert.doesNotMatch(toast.title, /undefined/);
});
