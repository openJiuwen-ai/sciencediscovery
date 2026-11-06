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
import { formatRunFailure, formatRunFailureTitle } from "../src/run-failure.js";

const { describe, it, beforeEach } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

describe("formatRunFailure", () => {
  beforeEach(() => {
    setLanguage("en");
  });

  it("maps timeout to an actionable message", () => {
    assert.match(formatRunFailure("timeout"), /timed out/i);
  });

  it("maps rate-limited to an actionable message", () => {
    assert.match(formatRunFailure("rate-limited"), /limiting requests/i);
  });

  it("maps semantic-error to a neutral, actionable message", () => {
    // `semantic-error` is the backend's catch-all, so the message should not
    // claim the model service explicitly rejected the request.
    const message = formatRunFailure("semantic-error");
    assert.doesNotMatch(message, /rejected/i);
    assert.match(message, /unexpected issue/i);
  });

  it("maps server-error to an actionable message", () => {
    assert.match(formatRunFailure("server-error"), /server error/i);
  });

  it("maps transport-error to an actionable message", () => {
    assert.match(formatRunFailure("transport-error"), /could not be reached/i);
  });

  it("maps unauthorized to an actionable message", () => {
    assert.match(formatRunFailure("unauthorized"), /rejected the credentials/i);
  });

  it("maps invalid-tool-call to an actionable message", () => {
    assert.match(formatRunFailure("invalid-tool-call"), /tool call/i);
  });

  it("falls back to the unknown message for an unrecognised code", () => {
    assert.match(formatRunFailure("not-a-code"), /stopped before it could finish/i);
  });

  it("falls back when no code is supplied", () => {
    assert.match(formatRunFailure(undefined), /stopped before it could finish/i);
  });

  it("switches to Chinese when the active language is Chinese", () => {
    setLanguage("zh-CN");
    assert.match(formatRunFailure("timeout"), /超时/);
    assert.match(formatRunFailure("transport-error"), /无法连接模型服务/);
    assert.match(formatRunFailure("semantic-error"), /意外问题/);
  });
});

describe("failure titles and timeout guidance", () => {
  beforeEach(() => setLanguage("zh-CN"));

  it("uses a specific title for every stable failure class and a safe fallback", () => {
    const titles = {
      timeout: "运行超时",
      unauthorized: "模型鉴权失败",
      "rate-limited": "模型请求受限",
      "transport-error": "模型服务连接失败",
      "server-error": "模型服务异常",
      "invalid-tool-call": "工具调用无效",
      "semantic-error": "运行异常",
    };
    for (const [code, title] of Object.entries(titles)) assert.equal(formatRunFailureTitle(code), title);
    for (const code of [undefined, "future-code", "__proto__", "constructor"]) {
      assert.equal(formatRunFailureTitle(code), "运行失败");
      assert.equal(formatRunFailure(code), formatRunFailure(undefined));
    }
  });

  it("explains the actual Agent idle duration and the matching recovery setting", () => {
    assert.equal(
      formatRunFailure("timeout", "Agent run stalled: no gateway progress for 1500 ms"),
      "Agent 在 1.5 秒内没有产生进展，运行已终止。建议重试，或在系统设置中适当增加 Agent 空闲超时时间。",
    );
  });

  it("prefers persisted metadata to incidental durations in raw diagnostics", () => {
    const summary = formatRunFailure("timeout", "no gateway progress for 1000 ms", { kind: "gateway_turn", timeoutMs: 2500 });
    assert.match(summary, /单轮运行已超过 2.5 秒/);
    assert.match(summary, /增加单轮超时时间/);
    assert.doesNotMatch(summary, /空闲超时/);
  });

  it("does not invent durations or an idle-timeout cause for generic or malformed errors", () => {
    const generic = formatRunFailure("timeout");
    for (const raw of ["request timeout", "no gateway progress for -1000 ms", "no gateway progress for NaN ms"]) {
      assert.equal(formatRunFailure("timeout", raw), generic);
    }
    for (const timeoutMs of [0, -1, NaN, Infinity]) {
      assert.equal(formatRunFailure("timeout", "no gateway progress for 1000 ms", { kind: "gateway_idle", timeoutMs }), generic);
    }
    assert.doesNotMatch(generic, /Agent 空闲/);
  });

  it("keeps each timeout's cause and recovery setting distinct", () => {
    const cases = [
      ["gateway turn exceeded 2000 ms", /单轮运行已超过 2 秒/, /增加单轮超时时间/],
      ["permission wait timed out after 3000 ms", /授权请求在 3 秒内/, /增加授权等待超时时间/],
      ["execution timed out after 4000 ms", /工具执行已超过 4 秒/, /增加执行超时时间/],
      ["evaluation timed out after 5000 ms", /工具执行已超过 5 秒/, /增加执行超时时间/],
      ["kernel idle timeout after 6000 ms", /内核空闲时间已达到 6 秒/, /增加内核空闲超时时间/],
    ] as const;
    for (const [raw, cause, setting] of cases) {
      const summary = formatRunFailure("timeout", raw);
      assert.match(summary, cause);
      assert.match(summary, setting);
      assert.doesNotMatch(summary, /Agent 空闲超时/);
      if (/execution|evaluation|kernel/.test(raw)) assert.doesNotMatch(summary, /运行已终止/);
    }
  });

  it("uses English titles, seconds and matching advice after switching languages", () => {
    setLanguage("en");
    assert.equal(formatRunFailureTitle("timeout"), "Run timed out");
    assert.match(formatRunFailure("timeout", "no gateway progress for 1000 ms"), /no progress for 1 second,.*Agent idle timeout/);
    assert.doesNotMatch(formatRunFailure("timeout", "no gateway progress for 1000 ms"), /1 seconds/);
    assert.match(formatRunFailure("timeout", "no gateway progress for 2500 ms"), /no progress for 2.5 seconds/);
  });
});


describe("timeout scope", () => {
  it("uses tool and kernel titles from metadata in both languages", () => {
    for (const [locale, toolTitle, kernelTitle] of [["zh-CN", "工具执行超时", "内核空闲超时"], ["en", "Tool execution timed out", "Kernel idle timeout"]] as const) {
      setLanguage(locale);
      assert.equal(formatRunFailureTitle("timeout", "opaque", { kind: "runner_exec", timeoutMs: 1000 }), toolTitle);
      assert.equal(formatRunFailureTitle("timeout", "opaque", { kind: "kernel_idle", timeoutMs: 1000 }), kernelTitle);
      // Persisted metadata wins over incidental text in the diagnostic.
      assert.equal(formatRunFailureTitle("timeout", "no gateway progress for 2000 ms", { kind: "runner_exec", timeoutMs: 1000 }), toolTitle);
    }
  });

  it("recognizes historical tool diagnostics without timeout metadata", () => {
    setLanguage("en");
    for (const raw of ["execution timed out after 4000 ms", "evaluation timed out after 5000 ms"]) {
      assert.equal(formatRunFailureTitle("timeout", raw, undefined, "notice"), "Tool execution timed out");
      assert.doesNotMatch(formatRunFailure("timeout", raw, undefined, "notice"), /run.*terminated/i);
    }
    assert.equal(formatRunFailureTitle("timeout", "kernel idle timeout after 6000 ms"), "Kernel idle timeout");
  });

  it("keeps unknown or malformed notices neutral while actual run failures stay explicit", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      setLanguage(locale);
      assert.equal(formatRunFailureTitle("timeout", "opaque", undefined, "notice"), locale === "en" ? "Timeout notice" : "超时提示");
      const malformed = { kind: "runner_exec", timeoutMs: 0 } as const;
      assert.doesNotMatch(formatRunFailure("timeout", "opaque", malformed, "notice"), /run.*terminated|运行已.*终止/i);
      assert.match(formatRunFailure("timeout"), /run.*terminated|运行已.*终止/i);
    }
  });
});
