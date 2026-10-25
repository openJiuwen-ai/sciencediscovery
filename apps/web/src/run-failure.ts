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

import type { RunFailureCode } from "@sciencediscovery/schema";

import type { MessageKey } from "./i18n/index.js";
import { translateActive } from "./i18n/index.js";

/** Plain-language cause and recovery action per stable failure class. */
const FAILURE_MESSAGE_KEYS: Record<RunFailureCode, MessageKey> = {
  "invalid-tool-call": "runFailure.invalid-tool-call",
  "rate-limited": "runFailure.rate-limited",
  "semantic-error": "runFailure.semantic-error",
  "server-error": "runFailure.server-error",
  timeout: "runFailure.timeout",
  "transport-error": "runFailure.transport-error",
  unauthorized: "runFailure.unauthorized",
};

/** Keep provider diagnostics separate from the cause and recovery guidance.
 * Older records and unrecognized codes still need an actionable message. */
export function formatRunFailure(code: RunFailureCode | undefined): string {
  const key = code && Object.hasOwn(FAILURE_MESSAGE_KEYS, code)
    ? FAILURE_MESSAGE_KEYS[code]
    : "runFailure.unknown";
  return translateActive(key);
}
