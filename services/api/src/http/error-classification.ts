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
 * Is this exception this server's own fault rather than the caller's mistake?
 *
 * A JavaScript runtime error means a handler dereferenced something that was
 * not there, and a `code` is a stable marker written by Node, the filesystem or
 * a dependency: neither is vocabulary a validator uses to address a reader.
 * They are decided before any prose is read (#1533), so an internal
 * `TypeError: Cannot read properties of undefined` cannot become a 400 that
 * echoes raw JavaScript text.
 */
export function isInternalFault(error: unknown): boolean {
  if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError) return true;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && code.length > 0;
}

/**
 * Legacy validators still throw plain Error objects. Keep their established
 * 400 responses while allowing genuinely unclassified faults to surface as
 * 500. New handlers should prefer ApiStatusError or a stable error code.
 *
 * The runtime/system gate is repeated here so a caller that asks this question
 * directly cannot reintroduce the inversion; the request catch-all also asks
 * `isInternalFault` first, before it falls back to the list below.
 */
export function isKnownClientInputError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  if (isInternalFault(error)) return false;
  if (!(error instanceof Error)) return false;
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
