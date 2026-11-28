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
 * A path segment that is not valid percent-encoding — `%%`, a stray `%`, or a
 * byte that does not form a UTF-8 sequence.
 *
 * It is the caller's own input, not a fault here, so it carries a stable code
 * and a message naming the parameter: the request handler answers 400 from both,
 * and the value itself is never put in the message, so nothing a client sent
 * comes back in the body or in the log.
 */
export class MalformedPathParam extends Error {
  readonly code = "MALFORMED_PATH_PARAM";

  constructor(parameter: string) {
    super(`Malformed path parameter: ${parameter}`);
    this.name = "MalformedPathParam";
  }
}

/**
 * `decodeURIComponent`, with an invalid escape reported as a client mistake.
 *
 * Route tables match a raw segment and decode it inline; an invalid escape used
 * to throw `URIError: URI malformed` into the generic handler, which answered
 * 500 and logged `unclassified_request_error`. Use this instead of
 * `decodeURIComponent` on anything that came out of a request path.
 */
export function decodePathParam(raw: string, parameter: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new MalformedPathParam(parameter);
  }
}
