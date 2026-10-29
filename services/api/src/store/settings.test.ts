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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import { DEFAULT_IDEA_TREE_SETTINGS, DEFAULT_WEB_SETTINGS, DEFAULT_SYSTEM_QUOTA_SETTINGS } from "@sciencediscovery/schema";

import { normalizeIdeaTreeSettings, resolveIdeaTreeSettings, normalizeWebSettings, normalizeQuotaSettings, resolveQuotaSettings } from "./settings.js";

test("subagent concurrency quota validates input and survives catalog normalization", () => {
  for (const value of [0, -1, 11, 1.5, "2", null]) {
    assert.throws(() => normalizeQuotaSettings({ ...DEFAULT_SYSTEM_QUOTA_SETTINGS, maxConcurrentSubagents: value }), /maxConcurrentSubagents/);
  }
  for (const limit of [1, 2, 10]) {
    const saved = normalizeQuotaSettings({ ...DEFAULT_SYSTEM_QUOTA_SETTINGS, maxConcurrentSubagents: limit });
    assert.equal(resolveQuotaSettings(JSON.parse(JSON.stringify(saved)), DEFAULT_SYSTEM_QUOTA_SETTINGS).maxConcurrentSubagents, limit);
  }
  assert.equal(resolveQuotaSettings({}, DEFAULT_SYSTEM_QUOTA_SETTINGS).maxConcurrentSubagents, undefined);
});

const base = {
  fetchCacheTtlSeconds: 86_400,
  fetchProvider: "jina",
  proxyPolicy: "inherit",
  searchCacheTtlSeconds: 3_600,
};

test("a stored paid route migrates to that paid provider alone, free tier off", () => {
  // The old route paid Tavily and had no free fallback, so migrating it must
  // not switch on engines the operator had no way of reaching before.
  const migrated = normalizeWebSettings({
    ...base,
    ddgsBackend: "bing",
    searchFallbackProvider: null,
    searchProvider: "tavily",
  });

  assert.deepEqual(migrated.paidSearchProviders, ["tavily"]);
  assert.deepEqual(migrated.freeSearchEngines, { bing: false, "brave-html": false, duckduckgo: false });
});

test("a stored free route migrates to the free tier without enabling paid providers", () => {
  const migrated = normalizeWebSettings({ ...base, ddgsBackend: "bing", searchProvider: "ddgs" });

  assert.deepEqual(migrated.paidSearchProviders, []);
  assert.deepEqual(migrated.freeSearchEngines, DEFAULT_WEB_SETTINGS.freeSearchEngines);
});

test("a paid route with a free fallback keeps both tiers", () => {
  const migrated = normalizeWebSettings({
    ...base,
    ddgsBackend: "auto",
    searchFallbackProvider: "ddgs",
    searchProvider: "exa",
  });

  assert.deepEqual(migrated.paidSearchProviders, ["exa"]);
  assert.deepEqual(migrated.freeSearchEngines, DEFAULT_WEB_SETTINGS.freeSearchEngines);
});

test("paid providers are stored in the fixed attempt order regardless of input order", () => {
  const normalized = normalizeWebSettings({
    ...base,
    freeSearchEngines: { bing: true, "brave-html": true, duckduckgo: true },
    paidSearchProviders: ["brave", "tavily"],
  });

  assert.deepEqual(normalized.paidSearchProviders, ["tavily", "brave"]);
});

test("unknown engines and non-boolean switches are rejected rather than coerced", () => {
  assert.throws(
    () => normalizeWebSettings({ ...base, freeSearchEngines: { google: true } }),
    /Unknown free search engine: google/,
  );
  assert.throws(
    () => normalizeWebSettings({ ...base, freeSearchEngines: { bing: "yes" } }),
    /freeSearchEngines.bing must be a boolean/,
  );
  assert.throws(
    () => normalizeWebSettings({ ...base, paidSearchProviders: ["ddgs"] }),
    /paidSearchProviders must list supported paid search providers/,
  );
  assert.throws(() => normalizeWebSettings({ ...base, searchEngine: "bing" }), /Unknown web setting/);
});


test("Idea Tree settings reject template-owned fields and discard their legacy catalog values", () => {
  const updated = normalizeIdeaTreeSettings({templateId: "water-treatment-materials/v1", explorationIntensity: "deep", maxTokens: 120000, maxTokensPerCall: 6000}, DEFAULT_IDEA_TREE_SETTINGS);
  const restored = resolveIdeaTreeSettings(JSON.parse(JSON.stringify(updated)));
  assert.equal(restored.maxTokens, 120000);
  assert.equal(restored.maxTokensPerCall, 6000);
  assert.equal(restored.templateId, "water-treatment-materials/v1");
  assert.equal(restored.explorationIntensity, "deep");
  assert.equal(normalizeIdeaTreeSettings({maxTokens: null}, restored).maxTokens, null);
  for (const input of [{maxRounds: 6}, {candidatesPerRound: 2}, {maxSearchRounds: 10}, {assessorActivity: {weight: 1}}]) {
    assert.throws(() => normalizeIdeaTreeSettings(input as never, restored), /configured by the selected template/);
  }
  const legacy = resolveIdeaTreeSettings({maxRounds: 6, candidatesPerRound: 2, maxSearchRounds: 10, assessorActivity: {weight: 1}});
  assert.equal("maxRounds" in legacy, false);
  assert.equal("assessorActivity" in legacy, false);
  for (const input of [{maxTokens: -1}, {maxTokensPerCall: 255}]) {
    assert.throws(() => normalizeIdeaTreeSettings(input, restored));
  }
});


test("Idea Tree accepts the server Lead Agent output ceiling", () => {
  assert.equal(DEFAULT_IDEA_TREE_SETTINGS.maxTokensPerCall, 32768);
  assert.equal(normalizeIdeaTreeSettings({maxTokensPerCall: 32768}, DEFAULT_IDEA_TREE_SETTINGS).maxTokensPerCall, 32768);
  assert.throws(() => normalizeIdeaTreeSettings({maxTokensPerCall: 32769}, DEFAULT_IDEA_TREE_SETTINGS));
});

test("Idea Tree stages inherit unless given their own effort, and the map survives storage", () => {
  // Nothing set: the stored settings carry no map at all, so unset users see no change.
  assert.equal("roleThinkingEfforts" in normalizeIdeaTreeSettings({}, DEFAULT_IDEA_TREE_SETTINGS), false);
  const updated = normalizeIdeaTreeSettings({ roleThinkingEfforts: { aggregate: "max", assess: "high", design: null as never } }, DEFAULT_IDEA_TREE_SETTINGS);
  assert.deepEqual(updated.roleThinkingEfforts, { assess: "high", aggregate: "max" });
  const restored = resolveIdeaTreeSettings(JSON.parse(JSON.stringify(updated)));
  assert.deepEqual(restored.roleThinkingEfforts, { assess: "high", aggregate: "max" });
  // Omitted keeps the map; null or an empty map returns every stage to inherit.
  assert.deepEqual(normalizeIdeaTreeSettings({ maxDepth: 3 }, restored).roleThinkingEfforts, { assess: "high", aggregate: "max" });
  assert.equal(normalizeIdeaTreeSettings({ roleThinkingEfforts: null }, restored).roleThinkingEfforts, undefined);
  assert.equal(normalizeIdeaTreeSettings({ roleThinkingEfforts: {} }, restored).roleThinkingEfforts, undefined);
  assert.throws(() => normalizeIdeaTreeSettings({ roleThinkingEfforts: { review: "high" } as never }, restored), /unknown stage: review/);
  assert.throws(() => normalizeIdeaTreeSettings({ roleThinkingEfforts: { design: "ultra" } as never }, restored), /roleThinkingEfforts.design must be/);
  // A stale stored value never wedges loading: the bad entries are dropped.
  assert.deepEqual(resolveIdeaTreeSettings({ roleThinkingEfforts: { design: "ultra", ideate: "low", old: "max" } }).roleThinkingEfforts, { ideate: "low" });
});
