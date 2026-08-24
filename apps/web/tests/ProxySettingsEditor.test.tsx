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
import { readFileSync } from "node:fs";
import test from "node:test";

import type { McpProxyPolicies, ProxySettingsDetails } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProxySettingsEditor, ProxyUrlGuideContent } from "../src/ProxySettingsEditor.js";
import { LocaleProvider } from "../src/i18n/index.js";

const settings: ProxySettingsDetails = {
  defaultPolicy: "proxy:primary",
  servers: [
    {
      createdAt: "2026-01-01T00:00:00Z",
      hasUrl: true,
      id: "primary",
      kind: "custom_url",
      name: "Primary corporate proxy",
      updatedAt: "2026-01-01T00:00:00Z",
      url: "http://research%40team:p%40ss%3Aword@proxy.example.test:8080/",
    },
    {
      createdAt: "2026-01-01T00:00:00Z",
      hasUrl: false,
      id: "environment",
      kind: "environment",
      name: "Environment variables",
      environment: {
        status: "configured",
        variables: [
          {
            effectiveName: "HTTPS_PROXY",
            effectiveValue: "http://env-user:env-secret@proxy.example.test:8080/?token=private",
            names: ["https_proxy", "HTTPS_PROXY"],
            status: "configured",
          },
          { names: ["http_proxy", "HTTP_PROXY"], status: "unconfigured" },
        ],
      },
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ],
};

test("renders complete settings URLs and independent MCP policies without persistent URL guidance", () => {
  const policies: McpProxyPolicies = { biomed: "proxy:primary", uniprot: "none" };
  const html = renderToStaticMarkup(createElement(ProxySettingsEditor, {
    mcpPolicies: policies,
    mcpServers: [
      { id: "biomed", label: "biomed · arXiv, PubMed" },
      { id: "uniprot", label: "uniprot · UniProt" },
    ],
    onCreate: async () => undefined,
    onDefaultPolicyChange: async () => undefined,
    onDelete: async () => undefined,
    onMcpPolicyChange: async () => undefined,
    onUpdate: async () => undefined,
    onWebProxyPolicyChange: () => undefined,
    settings,
    webProxyPolicy: "inherit",
  }));

  assert.match(html, /Network proxies/);
  assert.match(html, /Primary corporate proxy/);
  assert.match(html, /research%40team:p%40ss%3Aword@proxy\.example\.test:8080/);
  assert.match(html, /env-user:env-secret@proxy\.example\.test:8080/);
  assert.match(html, /HTTPS_PROXY/);
  assert.match(html, /Configured/);
  assert.match(html, /WebSearch proxy/);
  assert.match(html, /biomed · arXiv, PubMed/);
  assert.match(html, /uniprot · UniProt/);
  assert.match(html, /Inherit global default/);
  assert.match(html, /Do not use a proxy/);
  assert.doesNotMatch(html, /proxy-server-form/);
  assert.doesNotMatch(html, /proxy-url-info-trigger/);
  assert.doesNotMatch(html, /proxy-url-guide/);
  assert.doesNotMatch(html, /Proxy URL formats/);
  assert.ok(html.indexOf("Default proxy") < html.indexOf("Proxy server list"));
  assert.ok(html.indexOf("Proxy server list") < html.indexOf("Add proxy server"));
});

test("renders the redesigned proxy path in Simplified Chinese", () => {
  const html = renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ProxySettingsEditor, {
    mcpPolicies: {},
    mcpServers: [],
    onCreate: async () => undefined,
    onDefaultPolicyChange: async () => undefined,
    onDelete: async () => undefined,
    onMcpPolicyChange: async () => undefined,
    onUpdate: async () => undefined,
    onWebProxyPolicyChange: () => undefined,
    settings,
    webProxyPolicy: "inherit",
  })));

  assert.match(html, /默认代理/);
  assert.match(html, /代理服务器列表/);
  assert.match(html, /添加代理服务器/);
  assert.match(html, /已配置/);
  assert.match(html, /WebSearch 代理/);
  assert.doesNotMatch(html, /代理 URL 格式/);
  assert.doesNotMatch(html, /proxy-url-info-trigger/);
});

test("renders all proxy URL guidance in English and Simplified Chinese", () => {
  const english = renderToStaticMarkup(createElement(ProxyUrlGuideContent));
  const chinese = renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ProxyUrlGuideContent)));

  for (const value of [
    "http://proxy.example.test:8080",
    "https://proxy.example.test:8443",
    "socks5://proxy.example.test:1080",
    "scheme://username:password@host:port",
    "http://research%40team:p%40ss%3Aword@proxy.example.test:8080",
  ]) assert.match(english, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(english, /Percent-encode reserved characters/);
  assert.match(chinese, /代理 URL 格式/);
  assert.match(chinese, /保留字符/);
  assert.match(chinese, /实验性支持/);
});

test("keeps the add form collapsed and preserves correction state on failed save", () => {
  const source = readFileSync(new URL("../src/ProxySettingsEditor.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles/settings.css", import.meta.url), "utf8");
  assert.match(source, /useState\(false\)/);
  assert.match(source, /!formOpen \? <button className="secondary-button proxy-add-button"/);
  assert.match(source, /formOpen \? <form[^>]+className="proxy-server-form"/);
  assert.match(source, /catch \(reason\)[\s\S]*setFormError/);
  assert.match(source, /await onCreate[\s\S]*closeForm\(\)/);
  assert.match(source, /type="button" onClick=\{closeForm\}/);
  assert.match(source, /url: server\.url \?\? ""/);
  assert.match(source, /type="text"/);
  assert.match(source, /draft\.kind === "custom_url" \? <div className="proxy-url-field">/);
  assert.match(source, /aria-expanded=\{open\}/);
  assert.match(source, /aria-describedby=\{open \? tooltipId : undefined\}/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /document\.addEventListener\("pointerdown"/);
  assert.match(source, /onMouseEnter=/);
  assert.match(source, /onFocus=/);
  assert.match(source, /position: "fixed"/);
  assert.match(source, /trigger\.closest<HTMLElement>\("\.system-config-dialog"\)/);
  assert.match(styles, /\.proxy-url-info-trigger \{[^}]*border: 0;/);
  assert.match(styles, /\.proxy-url-tooltip \{ position: fixed;[^}]*z-index: 30;/);
});
