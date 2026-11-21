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

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });

import assert from "node:assert/strict";

import { estimateHoldMilli, estimateInputTokens, settleMilli, type ModelPrice } from "./pricing.js";

// 1 credit = 0.08 CNY, so these are the peak-time list prices: input ¥2/M,
// cached input ¥0.2/M, output ¥4/M (flash) or ¥8/M (V4.1-Flash).
const FLASH: ModelPrice = { model: "deepseek-v4-flash", inputMilliPer1k: 25, cachedInputMilliPer1k: 3, outputMilliPer1k: 50 };
const FLASH_41: ModelPrice = { model: "deepseek-v4.1-flash", inputMilliPer1k: 25, cachedInputMilliPer1k: 3, outputMilliPer1k: 100 };
const PRO: ModelPrice = { model: "deepseek-v4-pro", inputMilliPer1k: 150, cachedInputMilliPer1k: 15, outputMilliPer1k: 300 };

test("input tokens are estimated pessimistically", () => {
  assert.equal(estimateInputTokens(0), 0);
  assert.equal(estimateInputTokens(1), 1);
  assert.equal(estimateInputTokens(100), 75);
  assert.equal(estimateInputTokens(1500), 1125);
});

test("a hold covers the estimated input plus the full output budget", () => {
  // 1125 input at 25 milli/1k = 28.125 milli; 400 output at 100 milli/1k = 40 milli.
  assert.equal(estimateHoldMilli(1500, 400, FLASH_41), 69);
  assert.equal(estimateHoldMilli(0, 1000, FLASH), 50);
});

test("a hold never falls below one milli-credit", () => {
  assert.equal(estimateHoldMilli(1, 1, FLASH), 1);
  assert.equal(estimateHoldMilli(0, 0, FLASH), 1);
});

test("settlement charges what was used and bills cache hits at the cached rate", () => {
  // 700 fresh + 300 cached + 400 output on V4.1-Flash = 17.5 + 0.9 + 40 = 58.4 milli.
  assert.equal(settleMilli(1000, 300, 400, FLASH_41), 59);
  // The same call on the default model is cheaper but still rounds up.
  assert.equal(settleMilli(1000, 300, 400, FLASH), 39);
  assert.equal(settleMilli(0, 0, 500, PRO), 150);
});

test("a typical 8k input + 1k output call costs about 0.3 credits (¥0.024)", () => {
  assert.equal(settleMilli(8000, 0, 1000, FLASH_41), 300);
  // A full 1250-credit budget therefore buys roughly 4100 such calls.
  assert.ok((1250 * 1000) / 300 > 4000);
});

test("settlement is free when no tokens were reported, and cache hits never exceed input", () => {
  assert.equal(settleMilli(0, 0, 0, FLASH), 0);
  // 100 input, all cached: 100 tokens at 3 milli/1k = 0.3 milli, rounded up.
  assert.equal(settleMilli(100, 999, 0, FLASH), 1);
});
