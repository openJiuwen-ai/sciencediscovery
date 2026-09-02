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

type Settings = Parameters<typeof SandboxNetworkSettingsEditor>[0]["settings"];
type ProxySettings = Parameters<typeof SandboxNetworkSettingsEditor>[0]["proxySettings"];

const PROXY_REGISTRY: ProxySettings = {
  defaultPolicy: "none",
  servers: [{
    createdAt: "2026-01-01T00:00:00.000Z",
    hasUrl: true,
    id: "corp",
    kind: "custom_url",
    name: "Corporate",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }],
};

function render(settings: Settings, proxySettings?: ProxySettings): string {
  return renderToStaticMarkup(
    createElement(SandboxNetworkSettingsEditor, { onChange: () => undefined, proxySettings, settings }),
  );
}

test("renders the sandbox network access modes and allowed domains", () => {
  const html = render({
    allowPrivateNetwork: false,
    allowedDomains: ["api.example.org", "*.pypi.org"],
    egressProxyPolicy: "inherit",
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
  const html = render(
    { allowPrivateNetwork: false, allowedDomains: [], egressProxyPolicy: "inherit", mode: "none" },
    PROXY_REGISTRY,
  );
  // The domain list, the private-address switch and the outbound route: all
  // three only mean something once a domain can be allowed at all.
  assert.equal((html.match(/disabled/g) ?? []).length, 3);
});

test("the outbound route offers the same three choices a model does", () => {
  const html = render(
    {
      allowPrivateNetwork: false,
      allowedDomains: ["api.example.org"],
      egressProxyPolicy: "proxy:corp",
      mode: "domain-allowlist",
    },
    PROXY_REGISTRY,
  );
  assert.match(html, /Outbound route for allowed traffic/);
  assert.match(html, /<option value="inherit">/);
  assert.match(html, /<option value="none">/);
  assert.match(html, /<option value="proxy:corp"[^>]*>Corporate · Custom URL</);
  assert.match(html, /<option value="proxy:corp" selected/);
  // The ordering is the point of the whole feature, so it is stated next to
  // the control rather than left to the reader.
  assert.match(html, /Applied only <em>after<\/em> a domain is allowed/);
  assert.match(html, /never offered onward/);
  // Without the registry the control degrades instead of guessing a value.
  const withoutRegistry = render({
    allowPrivateNetwork: false,
    allowedDomains: ["api.example.org"],
    egressProxyPolicy: "inherit",
    mode: "domain-allowlist",
  });
  assert.match(withoutRegistry, /Loading the registered servers/);
  assert.doesNotMatch(withoutRegistry, /aria-label="Outbound route for allowed traffic"/);
});

/**
 * Naming regression: this capability is "sandbox network access", never a
 * proxy. The Network proxies settings group (Web/MCP outbound) is a separate
 * face and keeps its own wording.
 *
 * The outbound-route control does pick an entry from that other registry, so
 * proxy wording legitimately appears there — as a reference to Network proxies
 * and as the shared route choices. What must never happen is this capability
 * being *named* a proxy, so the guard is on the names it gives itself: the
 * heading, the group legends and the labels of its own controls.
 */
test("the sandbox network settings never call this capability a proxy", () => {
  const html = render({
    allowPrivateNetwork: true,
    allowedDomains: ["api.example.org"],
    egressProxyPolicy: "proxy:corp",
    mode: "domain-allowlist",
  }, PROXY_REGISTRY);
  // The cross-reference that names the other feature and scopes it out stays.
  assert.match(html, /Web and MCP outbound servers are configured separately under Network proxies[^.]*\./);
  // No phrasing anywhere that turns this capability into "a proxy".
  assert.doesNotMatch(html, /sandbox\s*prox|prox\w*\s+sandbox|沙箱\s*代理/i);
  const ownNames = [
    ...html.matchAll(/<(?:h3|legend)>([^<]*)</g),
    ...html.matchAll(/<span>([^<]*)</g),
    ...html.matchAll(/aria-label="([^"]*)"/g),
  ].map((match) => match[1] ?? "");
  assert.ok(ownNames.length >= 6, `expected the section's own names, saw ${ownNames.join(" | ")}`);
  for (const name of ownNames) assert.doesNotMatch(name, /prox(?:y|ies)|代理/i);
});

test("the settings group labels describe sandbox network access without proxy wording", () => {
  for (const catalog of [en, zhCN]) {
    const label = catalog["settings.groups.sandbox-network.label"];
    const description = catalog["settings.groups.sandbox-network.description"];
    assert.ok(label && description, "missing sandbox network group labels");
    assert.doesNotMatch(`${label} ${description}`, /proxy|代理/i);
  }
});
