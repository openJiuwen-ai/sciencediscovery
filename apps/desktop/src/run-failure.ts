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

import { TEXT } from "./text.js";

const FAILURE_MESSAGE_KEYS: Record<RunFailureCode, keyof typeof TEXT.runFailure> = {
  "invalid-tool-call": "invalid-tool-call",
  "rate-limited": "rate-limited",
  "semantic-error": "semantic-error",
  "server-error": "server-error",
  timeout: "timeout",
  "transport-error": "transport-error",
  unauthorized: "unauthorized",
};

/** Translate a stable failure code into a user-facing, actionable summary.
 *  The active language is resolved at render time through `TEXT`.
 *  Accepts `string` because the streamed error state stores the code as a plain
 *  string; any value that is not a recognised code falls back to the unknown
 *  message. */
export function formatRunFailure(code: RunFailureCode | string | undefined): string {
  const key =
    code && Object.hasOwn(FAILURE_MESSAGE_KEYS, code)
      ? FAILURE_MESSAGE_KEYS[code as RunFailureCode]
      : undefined;
  return key ? TEXT.runFailure[key] : TEXT.runFailure.unknown;
}
