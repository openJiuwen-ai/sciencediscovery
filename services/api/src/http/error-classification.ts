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
 * The error classes the interpreter itself raises when this server's own code
 * is wrong. They are never the caller's input, so the wording of their message
 * is not evidence about the caller and must not be read as such: the #1520
 * import fault reached the client as `400` with
 * `Cannot read properties of undefined (reading 'match')` because that text
 * matched /cannot/ below, and every internal `TypeError`, `RangeError`,
 * `ReferenceError` or `EvalError` whose message happens to say "invalid",
 * "cannot" or "must" would have followed it.
 */
const RUNTIME_FAULT_TYPES = [TypeError, RangeError, ReferenceError, EvalError] as const;

export function isRuntimeFault(error: unknown): boolean {
  return RUNTIME_FAULT_TYPES.some((fault) => error instanceof fault);
}

/**
 * Legacy validators still throw plain Error objects. Keep their established
 * 400 responses while allowing genuinely unclassified faults to surface as
 * 500. New handlers should prefer ApiStatusError or a stable error code.
 *
 * Only a non-runtime `Error` is matched against the wording list, because that
 * list is a record of what the legacy validators say, not a guess about prose
 * in general. `SyntaxError` stays a client error: a body that does not parse is
 * the caller's own bytes.
 */
export function isKnownClientInputError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  if (!(error instanceof Error)) return false;
  if (isRuntimeFault(error)) return false;
  return [
    /\bis required\b/i,
    /\bmust\b/i,
    /\bcontains? an unknown value\b/i,
    /\bcannot\b/i,
    /\bdoes not match\b/i,
    /\binvalid\b/i,
    // A caller-supplied string over its length limit. The stores that reject
    // one end the message with the phrase, so it is anchored to the end of the
    // message (allowing only a sentence period and trailing whitespace): the
    // caller gets the 400 that names the field, while an executor fault such as
    // `Runner bundle path is too long for tar: <path>` keeps the phrase
    // mid-sentence and its generic 500, so the path never reaches the client.
    /\bis too long\.?\s*$/i,
    /\bunsafe\b.*\b(?:archive|package|path)\b/i,
    /\bplain basename\b/i,
  ].some((pattern) => pattern.test(error.message));
}
