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
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

import { DEFAULT_WEB_SETTINGS } from "@sciencediscovery/schema";

import { jiuwenSwarmWebConfig, syncWebSettingsToJiuwenSwarm } from "./jiuwenswarm-web-settings.js";

const keys = { bocha: "bocha-key", jina: "jina-key" } as Record<string, string>;

test("the web settings become JiuwenSwarm's free engines and paid-search keys, and nothing else", () => {
  const settings = { ...DEFAULT_WEB_SETTINGS, freeSearchEngines: { duckduckgo: true, bing: false, "brave-html": true } };
  assert.deepEqual(jiuwenSwarmWebConfig(settings, (provider) => keys[provider]), {
    free_search_ddg_enabled: "true",
    free_search_bing_enabled: "false",
    jina_api_key: "jina-key",
    bocha_api_key: "bocha-key",
    serper_api_key: "",
    perplexity_api_key: "",
  });
});

test("the settings are posted to the adapter with its token", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchSpy = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response("{}"); }) as unknown as typeof fetch;
  const result = await syncWebSettingsToJiuwenSwarm({ adapterUrl: "http://adapter", adapterToken: "t", fetch: fetchSpy }, DEFAULT_WEB_SETTINGS, (provider) => keys[provider]);
  assert.equal(result.ok, true);
  assert.equal(calls[0]!.url, "http://adapter/agent/jiuwenswarm-config");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer t");
  assert.equal(JSON.parse(String(calls[0]!.init.body)).values.bocha_api_key, "bocha-key");
});

test("a failure is reported, not thrown", async () => {
  const refuse = (async () => new Response("down", { status: 502 })) as unknown as typeof fetch;
  const result = await syncWebSettingsToJiuwenSwarm({ adapterUrl: "http://adapter", fetch: refuse }, DEFAULT_WEB_SETTINGS, () => undefined);
  assert.equal(result.ok, false);
  assert.match(result.error!, /502/);
});

import { jiuwenSwarmWebResult } from "./jiuwenswarm-web-settings.js";

test("JiuwenSwarm's free search output becomes search rows", () => {
  const output = "Free search results (DuckDuckGo) for: perovskite\n1. Long-term stability - Nature\n   URL: https://nature.com/a\n   Snippet: We report\n2. Other\n   URL: https://example.org/b";
  assert.deepEqual(jiuwenSwarmWebResult("free_search", { query: "perovskite" }, output), { kind: "search", toolName: "free_search", rows: [
    { url: "https://nature.com/a", title: "Long-term stability - Nature", snippet: "We report" },
    { url: "https://example.org/b", title: "Other" },
  ] });
});

test("JiuwenSwarm's paid search sources, its fetched page, and failures", () => {
  assert.deepEqual(jiuwenSwarmWebResult("paid_search", {}, "Answer:\nIt is stable.\nURLs:\n1. https://x.example/1\n2. https://x.example/2"),
    { kind: "search", toolName: "paid_search", rows: [{ url: "https://x.example/1" }, { url: "https://x.example/2" }] });
  assert.deepEqual(jiuwenSwarmWebResult("fetch_webpage", { url: "https://x.example/1" }, "page text"),
    { kind: "fetch", toolName: "fetch_webpage", url: "https://x.example/1", content: "page text" });
  assert.equal(jiuwenSwarmWebResult("free_search", {}, "[ERROR]: free search failed: timeout"), undefined);
  assert.equal(jiuwenSwarmWebResult("free_search", {}, "No search results for: x"), undefined);
  assert.equal(jiuwenSwarmWebResult("bash", {}, "out"), undefined);
});
