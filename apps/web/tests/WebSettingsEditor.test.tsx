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

import type { WebSettingsDetails } from "@science-agent/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createWebSettingsDraft, WebSettingsEditor, webSettingsRequest } from "../src/WebSettingsEditor.js";

const settings = {
  ddgsBackend: "bing",
  fetchCacheTtlSeconds: 86_400,
  fetchProvider: "jina",
  providers: [
    { hasApiKey: false, provider: "ddgs" },
    { hasApiKey: true, provider: "jina" },
    { hasApiKey: false, provider: "tavily" },
    { hasApiKey: false, provider: "exa" },
    { hasApiKey: false, provider: "brave" },
  ],
  proxyPolicy: "proxy:corporate",
  searchCacheTtlSeconds: 3_600,
  searchFallbackProvider: null,
  searchProvider: "ddgs",
} satisfies WebSettingsDetails;

test("renders free defaults and write-only web credentials in one global settings form", () => {
  const html = renderToStaticMarkup(createElement(WebSettingsEditor, {
    draft: createWebSettingsDraft(settings),
    onChange: () => undefined,
    settings,
  }));

  assert.match(html, /DDGS backend/);
  assert.match(html, /Bing \(default\)/);
  assert.match(html, /WebSearch proxy selection is managed in Network proxies/);
  assert.doesNotMatch(html, /Web proxy|Inherit global default|Corporate proxy/);
  assert.match(html, /Jina API key/);
  assert.match(html, /Saved · enter a new key to replace it/);
  assert.doesNotMatch(html, /proxy-user|jina-secret/);
  assert.doesNotMatch(html, /Search fallback/);
});

test("labels the DDGS backend as fallback-only for a paid primary provider", () => {
  const html = renderToStaticMarkup(createElement(WebSettingsEditor, {
    draft: createWebSettingsDraft({ ...settings, searchFallbackProvider: "ddgs", searchProvider: "tavily" }),
    onChange: () => undefined,
    settings: { ...settings, searchFallbackProvider: "ddgs", searchProvider: "tavily" },
  }));

  assert.match(html, /Search fallback/);
  assert.match(html, /DDGS fallback backend/);
});

test("hides the DDGS backend when DDGS is absent from the search route", () => {
  const html = renderToStaticMarkup(createElement(WebSettingsEditor, {
    draft: createWebSettingsDraft({ ...settings, searchFallbackProvider: null, searchProvider: "exa" }),
    onChange: () => undefined,
    settings: { ...settings, searchFallbackProvider: null, searchProvider: "exa" },
  }));

  assert.match(html, /Search fallback/);
  assert.doesNotMatch(html, /DDGS (?:fallback )?backend/);
});

test("builds one deferred update request from provider and credential drafts", () => {
  const draft = createWebSettingsDraft(settings);
  const request = webSettingsRequest({
    ...draft,
    keys: { ...draft.keys, exa: "  exa-secret  " },
    remove: new Set(["jina"]),
  });

  assert.equal(request.proxyPolicy, "proxy:corporate");
  assert.deepEqual(request.providerApiKeys, { exa: "exa-secret", jina: null });
});
