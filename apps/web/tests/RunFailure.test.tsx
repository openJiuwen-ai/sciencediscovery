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


import type { RunFailureCode } from "@sciencediscovery/schema";
import { en, zhCN } from "../src/i18n/messages.js";
import { setActiveLocale } from "../src/i18n/locale.js";
import { formatRunFailure } from "../src/run-failure.js";

test("a failure class reads as a plain cause with a recovery action", () => {
  setActiveLocale("en");
  assert.match(
    formatRunFailure("rate-limited"),
    /^The model service is limiting requests\. Wait a moment and try again\.$/,
  );
  assert.match(
    formatRunFailure("transport-error"),
    /^The model service could not be reached\./,
  );
});

test("the Chinese locale renders the plain cause in Chinese", () => {
  setActiveLocale("zh-CN");
  assert.match(
    formatRunFailure("unauthorized"),
    /^模型服务拒绝了当前凭据，请检查模型注册表中的 API Key 后重试。$/,
  );
});

test("every stable failure class has a zh-CN message", () => {
  for (const code of ["invalid-tool-call", "rate-limited", "semantic-error", "server-error", "timeout", "transport-error", "unauthorized"] as const) {
    const key = `runFailure.${code}` as const;
    assert.ok(zhCN[key], `${key} needs a zh-CN message`);
  }
});

test("missing and future failure classes have localized recovery guidance", () => {
  for (const [locale, messages] of [["en", en], ["zh-CN", zhCN]] as const) {
    setActiveLocale(locale);
    assert.equal(formatRunFailure(undefined), messages["runFailure.unknown"]);
    assert.equal(formatRunFailure("future-failure" as RunFailureCode), messages["runFailure.unknown"]);
    assert.equal(formatRunFailure("toString" as RunFailureCode), messages["runFailure.unknown"]);
    assert.equal(formatRunFailure("timeout"), messages["runFailure.timeout"]);
  }
  setActiveLocale("en");
});
