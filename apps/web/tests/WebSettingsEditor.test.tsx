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
  fetchCacheTtlSeconds: 86_400,
  fetchProvider: "jina",
  freeSearchEngines: { bing: true, "brave-html": false, duckduckgo: true },
  paidSearchProviders: ["tavily", "exa", "brave"],
  providers: [
    { hasApiKey: true, provider: "jina" },
    { hasApiKey: true, provider: "tavily" },
    { hasApiKey: false, provider: "exa" },
    { hasApiKey: false, provider: "brave" },
  ],
  proxyPolicy: "proxy:corporate",
  searchCacheTtlSeconds: 3_600,
} satisfies WebSettingsDetails;

test("renders the search tiers in attempt order with write-only credentials", () => {
  const html = renderToStaticMarkup(createElement(WebSettingsEditor, {
    draft: createWebSettingsDraft(settings),
    onChange: () => undefined,
    settings,
  }));

  // Search is one aggregated capability now: no provider picker, no DDGS name.
  assert.doesNotMatch(html, /DDGS|Search provider|Search fallback/);
  assert.match(html, /Paid search providers \(tried first\)/);
  assert.match(html, /Free search engines \(tried after paid\)/);
  assert.match(html, /Tavily · key saved/);
  assert.match(html, /Exa · no key/);
  assert.match(html, /A provider without a saved API key is skipped/);
  assert.match(html, /A switched-off engine is never requested/);
  assert.match(html, /WebSearch proxy selection is managed in Network proxies/);
  assert.doesNotMatch(html, /Web proxy|Inherit global default|Corporate proxy/);
  assert.match(html, /Jina API key/);
  assert.match(html, /Saved · enter a new key to replace it/);
  assert.doesNotMatch(html, /proxy-user|jina-secret/);
});

test("free engine switches reflect the stored per-engine state", () => {
  const html = renderToStaticMarkup(createElement(WebSettingsEditor, {
    draft: createWebSettingsDraft(settings),
    onChange: () => undefined,
    settings,
  }));

  // brave-html is off in the fixture; the other two are on.
  const checkboxes = [...html.matchAll(/<input type="checkbox"([^>]*)\/?>/g)].map((match) => match[1] ?? "");
  assert.equal(checkboxes.length, 6);
  assert.deepEqual(
    checkboxes.slice(3).map((attributes) => attributes.includes("checked")),
    [true, true, false],
  );
});

test("the update request carries both tiers so a cleared selection is not silently kept", () => {
  const draft = createWebSettingsDraft(settings);
  const request = webSettingsRequest({
    ...draft,
    values: { ...draft.values, freeSearchEngines: { bing: false, "brave-html": false, duckduckgo: true }, paidSearchProviders: [] },
  });

  assert.deepEqual(request.paidSearchProviders, []);
  assert.deepEqual(request.freeSearchEngines, { bing: false, "brave-html": false, duckduckgo: true });
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
