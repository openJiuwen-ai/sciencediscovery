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

import assert from "node:assert/strict";

import { createTest } from "../../../test/support/tagged/compat.mjs";
import { setLanguage } from "../src/text.js";
import { formatRunFailure } from "../src/run-failure.js";

const { describe, it, beforeEach } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

describe("formatRunFailure", () => {
  beforeEach(() => {
    setLanguage("en");
  });

  it("maps every known RunFailureCode to an actionable English message", () => {
    assert.match(formatRunFailure("timeout"), /timed out/i);
    assert.match(formatRunFailure("rate-limited"), /limiting requests/i);
    assert.match(formatRunFailure("semantic-error"), /rejected/i);
    assert.match(formatRunFailure("server-error"), /server error/i);
    assert.match(formatRunFailure("transport-error"), /could not be reached/i);
    assert.match(formatRunFailure("unauthorized"), /rejected the credentials/i);
    assert.match(formatRunFailure("invalid-tool-call"), /tool call/i);
  });

  it("falls back to the unknown message for an unrecognised code", () => {
    assert.match(formatRunFailure("not-a-code" as any), /stopped before it could finish/i);
  });

  it("falls back when no code is supplied", () => {
    assert.match(formatRunFailure(undefined), /stopped before it could finish/i);
  });

  it("switches to Chinese when the active language is Chinese", () => {
    setLanguage("zh-CN");
    assert.match(formatRunFailure("timeout"), /请求超时/);
    assert.match(formatRunFailure("transport-error"), /无法连接模型服务/);
  });
});
