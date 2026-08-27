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

import { lookupModelCatalog, resolveModelFacts } from "@sciencediscovery/schema";

import { installTestModelCatalog } from "./models-dev.fixture.js";

test("a fact comes from the user first, then the provider listing, then the catalog", () => {
  installTestModelCatalog();
  const catalog = lookupModelCatalog("gpt-5.5", "openai")!;

  const resolved = resolveModelFacts({
    catalog,
    remote: { contextWindow: 400_000, maxOutputTokens: 64_000, thinkingSupported: true },
    user: { contextWindow: 1_048_576 },
  });
  assert.equal(resolved.contextWindow, 1_048_576, "what the user stated wins");
  assert.equal(resolved.origins.contextWindow, "user");
  assert.equal(resolved.maxOutputTokens, 64_000, "the listing answers where the user said nothing");
  assert.equal(resolved.origins.maxOutputTokens, "remote");
  assert.equal(resolved.origins.pricing, "catalog", "only the catalog published a price here");
  assert.equal(resolved.pricing?.currency, "USD");
});

test("typing a model id the catalog knows prefills its published facts", () => {
  installTestModelCatalog();
  // Exact match through the catalog's own normalization, including the
  // date-suffixed alias.
  const resolved = resolveModelFacts({ catalog: lookupModelCatalog("claude-haiku-4-5-20251001", "anthropic")! });
  assert.equal(resolved.contextWindow, 200_000);
  assert.equal(resolved.maxOutputTokens, 64_000);
  assert.equal(resolved.thinkingSupported, true);
  assert.equal(resolved.pricing?.input, 1);
  assert.equal(resolved.pricing?.output, 5);
  assert.deepEqual(resolved.origins, {
    contextWindow: "catalog",
    maxOutputTokens: "catalog",
    pricing: "catalog",
    thinkingSupported: "catalog",
  });
});

test("a model id the catalog does not know prefills nothing rather than guessing", () => {
  installTestModelCatalog();
  assert.equal(lookupModelCatalog("self-hosted-mystery-7b", "openai"), undefined);
  const resolved = resolveModelFacts({});
  assert.equal(resolved.contextWindow, undefined);
  assert.equal(resolved.maxOutputTokens, undefined);
  assert.equal(resolved.thinkingSupported, undefined);
  assert.equal(resolved.pricing, undefined);
  assert.deepEqual(resolved.origins, {}, "no source claimed any fact");
});

test("a user price is resolved without inventing a source to cite", () => {
  installTestModelCatalog();
  const resolved = resolveModelFacts({
    catalog: lookupModelCatalog("gpt-5.5", "openai")!,
    user: { pricing: { cachedInput: 0.2, currency: "CNY", input: 2, output: 8 } },
  });
  assert.equal(resolved.origins.pricing, "user");
  assert.equal(resolved.pricing?.currency, "CNY");
  assert.equal(resolved.pricing?.input, 2);
  assert.equal(resolved.pricing?.output, 8);
  assert.equal(resolved.pricing?.cachedInput, 0.2);
  assert.equal(resolved.pricing?.unit, "per-1m-tokens");
  assert.equal(resolved.pricing?.source, undefined, "a hand-entered rate has no published page");
});

test("false and zero are facts, not absences", () => {
  const resolved = resolveModelFacts({
    catalog: { label: "Stub", source: { retrievedAt: "2026-08-27", url: "https://example.test" }, thinking: { supported: true } },
    user: { pricing: { currency: "USD", input: 0, output: 0 }, thinkingSupported: false },
  });
  assert.equal(resolved.thinkingSupported, false, "an explicit false overrides a catalog true");
  assert.equal(resolved.origins.thinkingSupported, "user");
  assert.equal(resolved.pricing?.input, 0, "a free endpoint is a stated price, not unknown");
  assert.equal(resolved.origins.pricing, "user");
});
