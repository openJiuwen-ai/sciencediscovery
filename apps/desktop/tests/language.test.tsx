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

import {
  getLanguage,
  setLanguage,
  subscribeLanguage,
  TEXT,
} from "../src/text.js";
import type { PermissionRequest } from "../src/api/types.js";
import { PermissionCard } from "../src/views/PermissionCard.js";
import { providerName } from "../src/views/provider-name.js";
import { sessionTitle } from "../src/app/session-title.js";
import { GeneralSettings } from "../src/views/settings/GeneralSettings.js";
import { ThinkingBlock } from "../src/views/ThinkingBlock.js";

// The store is module state, so every test leaves it in the default language
// for the next one — and for the other test files the runner may load after.
afterEach(() => setLanguage("zh-CN"));

test("the app opens in Chinese and TEXT reads the Chinese dictionary", () => {
  assert.equal(getLanguage(), "zh-CN");
  assert.equal(TEXT.composer.send, "发送");
  assert.equal(TEXT.workspace.root, "工作区根目录");
});

test("switching to English changes every top-level section of TEXT", () => {
  setLanguage("en");
  assert.equal(getLanguage(), "en");
  // One read per section: the proxy must not serve a dictionary captured at
  // import time, which is the bug a plain `const TEXT = ...` would have.
  assert.equal(TEXT.composer.send, "Send");
  assert.equal(TEXT.sidebar.project, "Projects");
  assert.equal(TEXT.conversation.copyAnswer, "Copy answer");
  assert.equal(TEXT.settings.system.groups.general.label, "General");
  assert.equal(TEXT.settings.system.groups.timeouts.label, "Timeouts");
  assert.equal(TEXT.workspace.root, "Workspace root");
  assert.equal(TEXT.status.localOnline, "Local runtime · Online");
  // Functions are translated too, not just literals.
  assert.equal(TEXT.workspace.minutesAgo(3), "3 min ago");
  assert.equal(TEXT.conversation.thinkingSteps(2), "2 steps");
});

test("the choice is persisted under this app's own key", () => {
  const store = new Map<string, string>();
  const scope = globalThis as { localStorage?: unknown };
  scope.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  try {
    setLanguage("en");
    assert.equal(store.get("sciencediscovery-desktop:locale"), "en");
    setLanguage("zh-CN");
    assert.equal(store.get("sciencediscovery-desktop:locale"), "zh-CN");
  } finally {
    delete scope.localStorage;
  }
});

test("subscribers hear about a change, and switching to the same language is silent", () => {
  let calls = 0;
  const unsubscribe = subscribeLanguage(() => {
    calls += 1;
  });
  setLanguage("en");
  assert.equal(calls, 1);
  setLanguage("en");
  assert.equal(calls, 1, "a no-op switch should not re-render the app");
  unsubscribe();
  setLanguage("zh-CN");
  assert.equal(calls, 1, "an unsubscribed listener is not called");
});

test("a fold's 展开/收起 hint is translated, not baked into the stylesheet", () => {
  // The words are drawn by CSS from `details[open]`, so they travel as
  // attributes with the language's own text in them.
  const chinese = renderToStaticMarkup(<ThinkingBlock live={false} text={"第一步\n第二步"} truncated={false} />);
  assert.match(chinese, /data-expand="▸ 展开"/);
  assert.match(chinese, /data-collapse="▼ 收起"/);

  setLanguage("en");
  const english = renderToStaticMarkup(<ThinkingBlock live={false} text={"step one\nstep two"} truncated={false} />);
  assert.match(english, /data-expand="▸ Expand"/);
  assert.match(english, /data-collapse="▼ Collapse"/);
});

test("a permission card's buttons are drawn in the language in force", () => {
  // The buttons were once a module-level table holding the strings themselves,
  // which froze them in the language the app started in: switching to English
  // left the card saying 仅允许一次. Rendering it twice is the whole test.
  const request: PermissionRequest = {
    action: "sandbox",
    createdAt: "2026-01-01T00:00:00Z",
    id: "p1",
    resource: "python:run",
    state: "pending",
    summary: "跑一段代码",
  };
  const card = () => renderToStaticMarkup(
    <PermissionCard busy={false} interactive onDecision={() => {}} request={request} />,
  );

  const chinese = card();
  assert.match(chinese, /仅允许一次/);
  assert.match(chinese, /允许同类操作/);
  assert.match(chinese, /拒绝/);

  setLanguage("en");
  const english = card();
  assert.match(english, /Allow once/);
  assert.match(english, /Allow this kind/);
  assert.match(english, /Deny/);
  assert.doesNotMatch(english, /仅允许一次/);
});

test("通用 offers both languages and shows the one in force", () => {
  const chinese = renderToStaticMarkup(<GeneralSettings />);
  assert.match(chinese, /list-select-trigger/);
  assert.match(chinese, /简体中文/);
  assert.match(chinese, /界面语言/);
  // The sentence that used to explain the row is gone: the label says it.
  assert.doesNotMatch(chinese, /选择此浏览器中/);

  setLanguage("en");
  const english = renderToStaticMarkup(<GeneralSettings />);
  assert.match(english, /Interface language/);
  assert.match(english, /English/);
  assert.doesNotMatch(english, /Choose the language/);
  // The Chinese choice is not spelled in English: somebody reading the English
  // page has to be able to find their own language without reading it first.
  assert.equal(TEXT.settings.general.language.chinese, "简体中文");
});

test("the service's untitled sentinel is printed in the interface language", () => {
  // The service stores an English sentence for a session nobody has named, so
  // it is a stored value, not UI chrome — but it is still UI text.
  assert.equal(sessionTitle("Untitled session"), "未命名会话");
  assert.equal(sessionTitle("   "), "未命名会话");
  // A real title is the user's, and is never translated.
  assert.equal(sessionTitle("结构比对"), "结构比对");

  setLanguage("en");
  assert.equal(sessionTitle("Untitled session"), "Untitled session");
  assert.equal(sessionTitle(""), "Untitled session");
  assert.equal(sessionTitle("结构比对"), "结构比对");
});

test("the custom gateway this app creates is named in the interface language", () => {
  // The name is stored once at creation, so a provider made in one language is
  // read back in the other.
  assert.equal(providerName("自定义网关"), "自定义网关");
  assert.equal(providerName("Custom gateway"), "自定义网关");
  // A profile's name is the provider and the model joined by the service.
  assert.equal(providerName("Custom gateway · DeepSeek-V4.1-Flash"), "自定义网关 · DeepSeek-V4.1-Flash");
  // A name the user typed is left exactly as it is.
  assert.equal(providerName("My gateway"), "My gateway");
  assert.equal(providerName("My gateway · DeepSeek-V4.1-Flash"), "My gateway · DeepSeek-V4.1-Flash");

  setLanguage("en");
  assert.equal(providerName("自定义网关"), "Custom gateway");
  assert.equal(providerName("Custom gateway"), "Custom gateway");
  assert.equal(providerName("自定义网关 · DeepSeek-V4.1-Flash"), "Custom gateway · DeepSeek-V4.1-Flash");
  assert.equal(providerName("My gateway"), "My gateway");
});
