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
 * The sentences the engine itself writes. A plain `Error` can carry one of them
 * verbatim, for instance when a handler re-wraps `cause.message`, so the type
 * check above is not enough: `Cannot read properties of undefined (reading
 * 'match')` has to stay a 500 even when it arrives inside an `Error`.
 *
 * Every pattern keeps the part that makes the wording unmistakable: a binding
 * that is not a function, a value that is undefined where the engine needed an
 * object, an array or stack limit. Legacy validators describe the caller's own
 * field instead (`after_ms must be a positive integer`, `... is required`), so
 * they do not take these shapes; the suite pins both directions.
 */
const INTERPRETER_FAULT_WORDING: readonly RegExp[] = [
  // TypeError: `Cannot read properties of undefined (reading 'match')`, and the
  // pre-ES2021 `Cannot read property 'match' of undefined`.
  /\bCannot read propert(?:y|ies)\b[^]*\bof (?:undefined|null)\b/,
  // TypeError: `Cannot set properties of undefined (setting 'x')`, and the
  // older `Cannot set property 'x' of undefined`.
  /\bCannot set propert(?:y|ies)\b[^]*\bof (?:undefined|null)\b/,
  // TypeError: `Cannot use 'in' operator to search for 'x' in undefined`.
  /\bCannot use 'in' operator to search for\b/,
  // TypeError: `Cannot create property 'x' on string 'y'`.
  /\bCannot create property\b[^]*\bon (?:string|number|boolean|symbol|bigint)\b/,
  // TypeError: `Cannot destructure property 'x' of 'y' as it is undefined.`
  /\bCannot destructure (?:property\b|'[^']*' as )/,
  // TypeError: `Cannot convert undefined or null to object`, `Cannot convert a
  // BigInt value to a number`, `Cannot convert object to primitive value`.
  /\bCannot convert (?:undefined or null to object|a BigInt value to a number|object to primitive value)\b/,
  // TypeError: `state.items is not a function` / `x is not iterable`;
  // ReferenceError: `params is not defined`.
  /\bis not (?:a function|iterable|defined)\.?\s*$/,
  // RangeError: `Invalid array length`, `Invalid string length`.
  /\bInvalid (?:array|string) length\b/,
  // RangeError: `Maximum call stack size exceeded`.
  /\bMaximum call stack size exceeded\b/,
  // TypeError: `Assignment to constant variable.`
  /\bAssignment to constant variable\b/,
];

function quotesInterpreterFault(message: string): boolean {
  return INTERPRETER_FAULT_WORDING.some((pattern) => pattern.test(message));
}

/**
 * An `Error` labelled with a string `code` was classified by the layer that
 * raised it, not described in prose: Node and the filesystem use codes for
 * system faults (`ERR_SQLITE_ERROR`, `ENOTDIR`, ...), and a handler that does
 * know the answer uses a stable code too, which the catch-all reads before this
 * classifier runs (`CONFLICT`, `INVALID_UPLOAD_PATH`, ...). #1533 names such a
 * code as a legitimate source of a 400 beside `ApiStatusError`, so the code,
 * not the wording, decides the branch — and a coded error that still reaches
 * the wording list is this server's own fault.
 */
function carriesExplicitCode(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0;
}

/**
 * Legacy validators still throw plain Error objects. Keep their established
 * 400 responses while allowing genuinely unclassified faults to surface as
 * 500. New handlers should prefer ApiStatusError or a stable error code.
 *
 * Only a non-runtime `Error` is matched against the wording list, because that
 * list is a record of what the legacy validators say, not a guess about prose
 * in general. Two kinds of `Error` are excluded before it: one whose text is
 * one of the engine's own sentences (that text is evidence about this server,
 * not about the caller, whatever class the re-wrap gave it), and one carrying a
 * string `code` (the code decides the answer; see `carriesExplicitCode`).
 * `SyntaxError` stays a client error: a body that does not parse is the
 * caller's own bytes.
 */
export function isKnownClientInputError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  if (!(error instanceof Error)) return false;
  if (isRuntimeFault(error)) return false;
  if (carriesExplicitCode(error)) return false;
  if (quotesInterpreterFault(error.message)) return false;
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
