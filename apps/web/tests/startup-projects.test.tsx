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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { App } from "../src/App.js";
import { LocaleProvider } from "../src/i18n/index.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installBrowserStubs(): { location: { pathname: string; search: string; hash: string } } {
  const location = { pathname: "/", search: "", hash: "" };
  const applyUrl = (url: string) => {
    const parsed = new URL(url, "http://localhost");
    location.pathname = parsed.pathname;
    location.search = parsed.search;
    location.hash = parsed.hash;
  };
  Object.assign(globalThis, {
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    },
    document: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      querySelector: () => null,
      documentElement: { style: {} },
    },
    window: {
      location,
      history: {
        replaceState: (_state: unknown, _title: string, url?: string | URL | null) => { if (url) applyUrl(String(url)); },
        pushState: (_state: unknown, _title: string, url?: string | URL | null) => { if (url) applyUrl(String(url)); },
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    },
  });
  return { location };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

function startupBody(path: string): unknown {
  const url = path.split("?")[0] ?? path;
  if (url === "/api/projects") return [{ id: "project-1", name: "Alpha Project" }];
  if (url === "/api/providers") return { presets: [], providers: [] };
  if (url === "/api/quota-settings") return { uploadMaxFileBytes: 1, uploadMaxRequestBytes: 2, runnerMaxWorkspaceBytes: 3 };
  if (url === "/api/model-catalog") return {};
  if (url === "/api/mcp/proxy-policies") return { policies: {} };
  if (url === "/api/search") return { results: [], hasMore: false, total: 0 };
  if (url.endsWith("/settings")) return { overrides: {}, effective: {} };
  return [];
}

test("a hung memory settings read does not keep the project sidebar or the address bar waiting", async () => {
  const browser = installBrowserStubs();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.split("?")[0] === "/api/memory/settings") return new Promise<Response>(() => undefined);
    return jsonResponse(startupBody(path));
  }) as typeof fetch;

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(App, { initialToken: "test-token" })));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const projects = renderer!.root.findByProps({ id: "projects-panel-content" });
    assert.match(extractText(projects), /Alpha Project/);
    assert.equal(projects.findAllByProps({ className: "nav-skeleton" }).length, 0);
    assert.equal(browser.location.pathname, "/projects/project-1");
  } finally {
    await act(async () => { renderer?.unmount(); });
    globalThis.fetch = previousFetch;
  }
});

function extractText(node: { children?: unknown[] } | null | undefined): string {
  if (!node || !node.children) return "";
  return node.children.map((child) => typeof child === "string" ? child : extractText(child as { children?: unknown[] })).join("");
}
