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
const { afterEach, test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { formatClock, formatStamp, setLanguage } from "../src/text.js";
import type { PermissionRequest } from "../src/api/types.js";
import { PermissionCard } from "../src/views/PermissionCard.js";

// The store is module state, so every test leaves it in the default language
// for the next one — and for the other test files the runner may load after.
afterEach(() => setLanguage("zh-CN"));

// Built from local components so the assertions do not depend on the host's
// time zone: the ISO string below names the same wall-clock instant.
const WHEN = new Date(2024, 0, 2, 9, 5, 0);

test("a timestamp is formatted in the interface language, not the host locale", () => {
  // `new Date(...).toLocaleString()` with no argument formats for the machine:
  // on an English-locale host it printed `1/2/2024, 9:05:00 AM` inside Chinese
  // text. The interface language decides now, and the option set is fixed so
  // the shape does not drift with the host either.
  assert.equal(formatStamp(WHEN), "2024/1/2 09:05");
  assert.equal(formatStamp(WHEN.toISOString()), "2024/1/2 09:05");
  assert.doesNotMatch(formatStamp(WHEN), /^1\/2\/2024, 9:05:00 AM$/);
});

test("the clock on a saved-at line follows the interface language", () => {
  assert.equal(formatClock(WHEN), "09:05");
  assert.equal(formatClock(WHEN.getTime()), "09:05");
  // No argument means "now"; it must still be a formatted clock, not the
  // 12-hour host form with seconds.
  assert.match(formatClock(), /^\d{2}:\d{2}/);
});

test("switching the interface language re-formats both helpers", () => {
  // Reading TEXT.languageTag at call time is what makes this work; a locale
  // captured at import time would keep answering in Chinese.
  setLanguage("en");
  const stamp = formatStamp(WHEN);
  assert.match(stamp, /^1\/2\/2024, 09:05/);
  assert.doesNotMatch(stamp, /2024\/1\/2/);
  assert.match(formatClock(WHEN), /^09:05[\s\u202f]?AM$/);
});

test("a permission card prints its request time in the interface language", () => {
  // The card is one of the six call sites: its `请求时间` is what a user reads
  // to judge whether a pending request is still theirs, so a month-first date
  // in Chinese text is a real misread risk.
  const request: PermissionRequest = {
    action: "sandbox",
    createdAt: WHEN.toISOString(),
    id: "p1",
    resource: "python:run",
    state: "pending",
    summary: "跑一段代码",
  };
  const card = () => renderToStaticMarkup(
    <PermissionCard busy={false} interactive onDecision={() => {}} request={request} />,
  );

  const chinese = card();
  assert.match(chinese, /2024\/1\/2 09:05/);
  // The pre-fix host-locale output, including the seconds the fixed shape drops.
  assert.doesNotMatch(chinese, /1\/2\/2024, 9:05:00 AM/);

  setLanguage("en");
  const english = card();
  assert.match(english, /1\/2\/2024, 09:05/);
  assert.doesNotMatch(english, /2024\/1\/2/);
});
