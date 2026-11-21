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

/**
 * Credit arithmetic for model calls.
 *
 * One displayed credit is 0.08 CNY. Prices live in `model_prices` as
 * milli-credits per 1000 tokens (1000 milli = 1 credit), and a charge is rounded
 * up to a milli-credit rather than to a whole credit: a typical call costs about
 * 0.3 credits, so rounding to whole credits would triple its price and break the
 * "1250 积分 = 100 元" budget. Two rules from the design doc are enforced here,
 * once, instead of at every call site:
 *   - a call is charged for what it actually used, rounded up to a milli-credit;
 *   - a hold is rounded up the same way and is pessimistic about input size,
 *     because an under-estimate would let a call spend credits it never froze.
 */

/** One displayed credit is 1000 stored units, so token pricing never rounds. */
export const MILLI_PER_CREDIT = 1000;

/**
 * Tokens per character. Mixed Chinese and code prompts usually sit between 0.5
 * and 0.7; 0.75 over-estimates on purpose so the hold covers the real input.
 */
const TOKENS_PER_CHAR = 0.75;

export interface ModelPrice {
  model: string;
  /** Milli-credits per 1000 uncached input tokens. */
  inputMilliPer1k: number;
  /** Milli-credits per 1000 cache-hit input tokens. */
  cachedInputMilliPer1k: number;
  /** Milli-credits per 1000 output tokens. */
  outputMilliPer1k: number;
}

export function estimateInputTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) * TOKENS_PER_CHAR);
}

/** Charges are rounded up to a milli-credit, the smallest unit the ledger keeps. */
function roundUpToCredit(milli: number): number {
  return Math.ceil(milli);
}

/** Credits to freeze before a call: estimated input plus the full output budget. */
export function estimateHoldMilli(inputChars: number, maxOutputTokens: number, price: ModelPrice): number {
  const inputTokens = estimateInputTokens(inputChars);
  const outputTokens = Math.max(0, maxOutputTokens);
  const milli = (inputTokens * price.inputMilliPer1k + outputTokens * price.outputMilliPer1k) / MILLI_PER_CREDIT;
  return Math.max(1, roundUpToCredit(milli));
}

/**
 * Credits to charge after a call. Cache hits are billed at the cached rate and
 * are capped at the reported input, so a broken usage report cannot refund more
 * than it consumed. A call with no tokens at all costs nothing.
 */
export function settleMilli(inputTokens: number, cachedTokens: number, outputTokens: number, price: ModelPrice): number {
  const totalInput = Math.max(0, inputTokens);
  const totalOutput = Math.max(0, outputTokens);
  if (totalInput === 0 && totalOutput === 0) return 0;
  const cached = Math.min(Math.max(0, cachedTokens), totalInput);
  const fresh = totalInput - cached;
  const milli = (fresh * price.inputMilliPer1k + cached * price.cachedInputMilliPer1k + totalOutput * price.outputMilliPer1k) / MILLI_PER_CREDIT;
  return Math.max(1, roundUpToCredit(milli));
}
