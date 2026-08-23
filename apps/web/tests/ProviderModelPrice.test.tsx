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

import { lookupModelCatalog } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LocaleProvider } from "../src/i18n/index.js";
import { PriceSummary } from "../src/ProviderModelSettings.js";

test("DeepSeek price summary renders peak and off-peak rates instead of one ambiguous low price", () => {
  const html = renderToStaticMarkup(createElement(
    LocaleProvider,
    { initialLocale: "zh-CN" },
    createElement(PriceSummary, {
      model: { id: "deepseek-v4-flash", catalog: lookupModelCatalog("deepseek-v4-flash", "deepseek") },
    }),
  ));
  assert.match(html, /高峰: CNY 3 \/ 9/);
  assert.match(html, /缓存输入 0\.1/);
  assert.match(html, /闲时: CNY 1\.5 \/ 4\.5/);
  assert.match(html, /缓存输入 0\.05/);
  assert.match(html, /Beijing time/);
});
