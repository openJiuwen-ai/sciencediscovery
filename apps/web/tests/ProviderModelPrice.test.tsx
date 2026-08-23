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

import { LocaleProvider, translate } from "../src/i18n/index.js";
import {
  canonicalSourceUrl,
  createProviderListingRequestGuard,
  PriceSummary,
  providerOperationError,
  sourceDate,
} from "../src/ProviderModelSettings.js";

test("DeepSeek price summary localizes structured peak and off-peak schedules", () => {
  const render = (initialLocale: "en" | "zh-CN") => renderToStaticMarkup(createElement(
    LocaleProvider,
    { initialLocale },
    createElement(PriceSummary, {
      model: { id: "deepseek-v4-flash", catalog: lookupModelCatalog("deepseek-v4-flash", "deepseek") },
    }),
  ));
  const chinese = render("zh-CN");
  assert.match(chinese, /高峰: CNY 3 \/ 9/);
  assert.match(chinese, /北京时间工作日 09:00–12:00, 14:00–18:00/);
  assert.match(chinese, /闲时: CNY 1\.5 \/ 4\.5/);
  assert.match(chinese, /其余时间（北京时间）/);
  assert.doesNotMatch(chinese, /见 periods|Beijing time/);

  const english = render("en");
  assert.match(english, /Peak: CNY 3 \/ 9/);
  assert.match(english, /Beijing time, weekdays 09:00–12:00, 14:00–18:00/);
  assert.match(english, /Off-peak: CNY 1\.5 \/ 4\.5/);
  assert.match(english, /All other times \(Beijing time\)/);
  assert.doesNotMatch(english, /工作日|其余时间|见 periods/);
});

test("source URLs and retrieval dates use canonical display forms", () => {
  assert.equal(
    canonicalSourceUrl("https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"),
    canonicalSourceUrl("https://api-docs.deepseek.com/zh-cn/quick_start/pricing"),
  );
  assert.equal(sourceDate("2026-08-23T22:21:02.976Z"), "2026-08-23");
  assert.equal(sourceDate("2026-08-23"), "2026-08-23");
});

test("only the latest Provider listing request may update the selected Provider", () => {
  const guard = createProviderListingRequestGuard();
  const providerA = guard.begin("provider-a");
  const providerB = guard.begin("provider-b");
  assert.equal(guard.isCurrent(providerA, "provider-a"), false);
  assert.equal(guard.isCurrent(providerA, "provider-b"), false);
  assert.equal(guard.isCurrent(providerB, "provider-b"), true);
  guard.invalidate();
  assert.equal(guard.isCurrent(providerB, "provider-b"), false);
});

test("Provider operation errors identify the failed refresh and localize runtime references", () => {
  assert.equal(translate("zh-CN", "providers.load.providersFailed"), "无法刷新服务商列表");
  assert.equal(translate("zh-CN", "providers.load.modelsFailed"), "无法刷新已配置模型列表");
  assert.equal(
    translate("zh-CN", "providers.delete.referenced"),
    "此服务商正被运行时设置引用。请先更换全局默认任务模型或评审模型，再删除服务商。",
  );
  assert.equal(
    providerOperationError(new Error("network down"), "无法刷新服务商列表", "请先更换全局默认模型"),
    "无法刷新服务商列表: network down",
  );
  assert.equal(
    providerOperationError(
      new Error("Provider models are referenced by runtime settings and cannot be deleted"),
      "无法删除服务商",
      "请先更换全局默认模型",
    ),
    "请先更换全局默认模型",
  );
});
