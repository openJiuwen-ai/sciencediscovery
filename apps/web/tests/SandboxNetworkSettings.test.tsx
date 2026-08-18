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

import { SandboxNetworkSettingsEditor } from "../src/RuntimeControls.js";
import { en, zhCN } from "../src/i18n/messages.js";

function render(settings: Parameters<typeof SandboxNetworkSettingsEditor>[0]["settings"]): string {
  return renderToStaticMarkup(createElement(SandboxNetworkSettingsEditor, { onChange: () => undefined, settings }));
}

test("renders the sandbox network access modes and allowed domains", () => {
  const html = render({
    allowPrivateNetwork: false,
    allowedDomains: ["api.example.org", "*.pypi.org"],
    mode: "domain-allowlist",
  });
  assert.match(html, /Sandbox network access/);
  assert.match(html, /No network/);
  assert.match(html, /Domain allowlist/);
  assert.match(html, /Allowed domains/);
  assert.match(html, /api\.example\.org/);
  assert.match(html, /Allow private and loopback addresses/);
  // The honest boundary must stay visible next to the control.
  assert.match(html, /TLS is not inspected/);
  assert.match(html, /rotates the Permission Epoch/);
});

test("the allowed-domain controls are disabled while the mode is No network", () => {
  const html = render({ allowPrivateNetwork: false, allowedDomains: [], mode: "none" });
  assert.equal((html.match(/disabled/g) ?? []).length, 2);
});

/**
 * Naming regression: this capability is "sandbox network access", never a
 * proxy. The Network proxies settings group (Web/MCP outbound) is a separate
 * face and keeps its own wording.
 */
test("the sandbox network settings never call this capability a proxy", () => {
  const html = render({
    allowPrivateNetwork: true,
    allowedDomains: ["api.example.org"],
    mode: "domain-allowlist",
  });
  // One cross-reference is allowed: it names the other feature and says it does
  // not apply here. Everything else must be free of proxy wording.
  const crossReference = /Web and MCP outbound servers are configured separately under Network proxies[^.]*\./;
  assert.match(html, crossReference);
  assert.doesNotMatch(html.replace(crossReference, ""), /prox(?:y|ies)|代理/i);
});

test("the settings group labels describe sandbox network access without proxy wording", () => {
  for (const catalog of [en, zhCN]) {
    const label = catalog["settings.groups.sandbox-network.label"];
    const description = catalog["settings.groups.sandbox-network.description"];
    assert.ok(label && description, "missing sandbox network group labels");
    assert.doesNotMatch(`${label} ${description}`, /proxy|代理/i);
  }
});
