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

import type { ModelCatalogDetails } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { SettingsApiClient } from "../src/api/settings.js";
import { LocaleProvider } from "../src/i18n/index.js";
import { ModelCatalogStatus } from "../src/ProviderModelSettings.js";

const FETCHED_AT = "2026-08-26T09:00:00.000Z";

function details(origin: "bundled" | "downloaded"): ModelCatalogDetails {
  return {
    snapshot: { fetchedAt: FETCHED_AT, origin, records: [], sourceUrl: "https://models.dev/api.json" },
    sourceUrl: "https://models.dev/api.json",
  };
}

function render(locale: "en" | "zh-CN", catalog?: ModelCatalogDetails): string {
  return renderToStaticMarkup(createElement(
    LocaleProvider,
    { initialLocale: locale },
    createElement(ModelCatalogStatus, {
      ...(catalog ? { catalog } : {}),
      client: {} as SettingsApiClient,
      onError: () => undefined,
      onNotice: () => undefined,
    }),
  ));
}

test("the catalog header states when the metadata was last updated, in both languages", () => {
  const expected = new Date(FETCHED_AT).toLocaleString();

  const english = render("en", details("downloaded"));
  assert.match(english, /Model metadata catalog/);
  assert.match(english, /Data source: models\.dev/);
  assert.match(english, new RegExp(`Last updated ${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(english, /<button [^>]*>Refresh catalog<\/button>/);

  const chinese = render("zh-CN", details("downloaded"));
  assert.match(chinese, /模型元数据目录/);
  assert.match(chinese, /数据来源：models\.dev/);
  assert.match(chinese, /最近更新于/);
  assert.match(chinese, /<button [^>]*>刷新目录<\/button>/);
  assert.doesNotMatch(chinese, /Last updated|Refresh catalog|Data source/);
});

test("a snapshot that shipped with the build says so instead of claiming a fresh download", () => {
  assert.match(render("en", details("bundled")), /Shipped with this build, last updated /);
  assert.match(render("zh-CN", details("bundled")), /随本次构建发布，最近更新于 /);
});

test("with no catalog the header says so and still offers the refresh", () => {
  const english = render("en");
  assert.match(english, /No catalog yet\./);
  assert.match(english, /<button [^>]*>Refresh catalog<\/button>/);
  assert.match(render("zh-CN"), /尚无目录数据。/);
});
