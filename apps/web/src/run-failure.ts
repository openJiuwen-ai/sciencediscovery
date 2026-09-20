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
  "rate-limited": "runFailure.rate-limited",
  "semantic-error": "runFailure.semantic-error",
  "server-error": "runFailure.server-error",
  timeout: "runFailure.timeout",
  "transport-error": "runFailure.transport-error",
  unauthorized: "runFailure.unauthorized",
};

/**
 * Render a failed run for the user: a plain-language cause and recovery
 * action first, then the original error text after a separator.
 *
 * The provider's own text is never dropped or summarized — diagnosing a
 * failure needs what actually came back from the endpoint — but it is no
 * longer the first thing the user reads. A failure without a class (older
 * records, or the class never being assigned) degrades to the raw text.
 */
export function formatRunFailure(code: RunFailureCode | undefined, error: string): string {
  const detail = error.trim();
  if (!code) return detail;
  const plain = translateActive(FAILURE_MESSAGE_KEYS[code]);
  return detail ? `${plain} · ${detail}` : plain;
}
