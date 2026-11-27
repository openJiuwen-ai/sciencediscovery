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

import { ApiStatusError } from "./api-status-error.js";

/**
 * Decode one path segment captured by a route pattern.
 *
 * `decodeURIComponent` throws `URIError: URI malformed` for an undecodable
 * escape such as `%%`. That is the caller's own input, so it answers 400 and
 * names the parameter instead of reaching the catch-all as an unclassified
 * 500. Every path-segment decode goes through this guard, because a bare
 * decode in any one route turns a local client mistake into a server fault.
 */
export function decodePathParameter(raw: string, parameter: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new ApiStatusError(400, `Invalid path parameter: ${parameter}`);
  }
}
