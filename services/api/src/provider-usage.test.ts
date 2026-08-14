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
import { test } from "node:test";

import { parseProviderUsage } from "./provider-usage.js";

test("USG-014 provider usage derives total and accepts cache field aliases", () => {
  const derived = parseProviderUsage({
    prompt_tokens: 20,
    completion_tokens: 5,
    prompt_cache_hit_tokens: 8,
    prompt_cache_miss_tokens: 2,
  });
  assert.equal(derived.usageStatus, "reported");
  assert.equal(derived.inputTokens, 20);
  assert.equal(derived.outputTokens, 5);
  assert.equal(derived.totalTokens, 25);
  assert.equal(derived.cacheReadTokens, 8);
  assert.equal(derived.cacheWriteTokens, 2);

  const nested = parseProviderUsage({
    input_tokens: 11,
    output_tokens: 4,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 3 },
    input_token_details: { cache_read: 7 },
  });
  assert.equal(nested.cacheReadTokens, 3);

  const fromInputDetails = parseProviderUsage({
    input_tokens: 11,
    output_tokens: 4,
    total_tokens: 15,
    input_token_details: { cache_read: 7 },
  });
  assert.equal(fromInputDetails.cacheReadTokens, 7);
});

test("USG-015 incomplete provider usage stays unreported", () => {
  const missing = parseProviderUsage({ input_tokens: 12 });
  assert.equal(missing.usageStatus, "provider-not-reported");
  assert.equal(missing.totalTokens, null);
});
