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
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { applyLocale, detectLocale, LocaleProvider, LOCALE_STORAGE_KEY, translate, useLocale } from "../src/i18n/index.js";
import { zhCN } from "../src/i18n/messages.js";

test("detects a stored locale before browser language and defaults fixtures to English", () => {
  assert.equal(detectLocale({ languages: ["zh-CN"], storedLocale: "en" }), "en");
  assert.equal(detectLocale({ languages: ["zh-Hans"] }), "zh-CN");
  assert.equal(detectLocale({ languages: ["fr-FR"] }), "en");
  assert.equal(detectLocale({ languages: [] }), "en");
});

test("falls back to the complete English table when a Chinese key is missing", () => {
  assert.equal(translate("zh-CN", "test.englishFallback"), "English fallback");
});

test("uses neutral workspace-file wording in both locales", () => {
  assert.equal(translate("en", "app.physicalFiles"), "View workspace files");
  assert.equal(translate("zh-CN", "app.physicalFiles"), "查看工作区文件");
  assert.doesNotMatch(translate("en", "app.physicalFilesHelp"), /developer|physical/i);
  assert.doesNotMatch(translate("zh-CN", "app.physicalFilesHelp"), /开发者|物理/);
});

test("localizes the NPU card selection, including the numbers in each line", () => {
  // The driver's own refusal text is not translated — it is what the machine
  // said — but everything the product writes around it is.
  assert.equal(translate("en", "remote.npuCount", { total: 8, usable: 4 }), "8 on this machine · 4 usable in the sandbox");
  assert.equal(translate("zh-CN", "remote.npuCount", { total: 8, usable: 4 }), "本机 8 张 · 沙箱内可用 4 张");
  assert.equal(translate("en", "remote.npuCard", { chip: "910B3", index: 4 }), "NPU 4 · 910B3");
  assert.equal(translate("zh-CN", "remote.npuCard", { chip: "910B3", index: 4 }), "NPU 4 · 910B3");
  assert.equal(translate("zh-CN", "remote.npuAiCore", { percent: 12 }), "AI Core 12%");
  assert.match(translate("zh-CN", "remote.npuUnusableSelected"), /取消勾选/);
  assert.match(translate("zh-CN", "remote.npuRenumbered"), /从 0 开始重新编号/);
  for (const key of ["remote.npuTitle", "remote.npuNone", "remote.npuUnusable", "remote.npuNoneUsable"] as const) {
    assert.ok(zhCN[key], `${key} needs a zh-CN message`);
  }
});

test("provides localized dialog error feedback actions", () => {
  assert.equal(translate("en", "error.settingsTitle"), "Settings error");
  assert.equal(translate("en", "error.dismiss"), "Dismiss error");
  assert.equal(translate("zh-CN", "error.settingsTitle"), "设置错误");
  assert.equal(translate("zh-CN", "error.dismiss"), "关闭错误");
});

test("localizes destructive model-profile confirmation", () => {
  assert.equal(translate("en", "providers.models.deleteConfirm", { name: "Analysis model" }), "Delete model profile “Analysis model”?");
  assert.equal(translate("zh-CN", "providers.models.deleteConfirm", { name: "分析模型" }), "删除模型配置“分析模型”？");
});

test("persists a locale switch and synchronizes the document language", () => {
  const writes: Array<[string, string]> = [];
  const documentElement = { lang: "en" };
  applyLocale("zh-CN", {
    documentElement,
    storage: { setItem: (key, value) => writes.push([key, value]) },
  });
  assert.deepEqual(writes, [[LOCALE_STORAGE_KEY, "zh-CN"]]);
  assert.equal(documentElement.lang, "zh-CN");
});

test("renders Chinese messages when the provider starts in zh-CN", () => {
  function Probe() {
    const { locale, t } = useLocale();
    return createElement("span", null, `${locale}:${t("app.systemConfiguration")}`);
  }
  const html = renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(Probe)));
  assert.match(html, /zh-CN:系统设置/);
});
