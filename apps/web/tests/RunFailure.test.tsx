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


import { zhCN } from "../src/i18n/messages.js";
import { setActiveLocale } from "../src/i18n/locale.js";
import { formatRunFailure } from "../src/run-failure.js";

test("a failure class reads as a plain cause with a recovery action, then the detail", () => {
  setActiveLocale("en");
  assert.match(
    formatRunFailure("rate-limited", "429 Too Many Requests"),
    /^The model service is limiting requests\. Wait a moment and try again\. · 429 Too Many Requests$/,
  );
  assert.match(
    formatRunFailure("transport-error", "fetch failed"),
    /^The model service could not be reached\./,
  );
});

test("the Chinese locale renders the plain cause in Chinese", () => {
  setActiveLocale("zh-CN");
  assert.match(
    formatRunFailure("unauthorized", "401 invalid api key"),
    /^模型服务拒绝了当前凭据，请检查模型注册表中的 API Key 后重试。 · 401 invalid api key$/,
  );
});

test("every stable failure class has a zh-CN message", () => {
  for (const code of ["rate-limited", "semantic-error", "server-error", "timeout", "transport-error", "unauthorized"] as const) {
    const key = `runFailure.${code}` as const;
    assert.ok(zhCN[key], `${key} needs a zh-CN message`);
  }
});

test("a failure without a class degrades to the original error text", () => {
  setActiveLocale("en");
  assert.equal(formatRunFailure(undefined, "Gateway is unavailable"), "Gateway is unavailable");
  assert.equal(formatRunFailure("timeout", "  "), "The request timed out. Retry, or split the task / raise the timeout budget.");
});
