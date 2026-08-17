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

import type { RunFailureCode } from "@science-agent/schema";

/**
 * Render a failed run for the user: the stable class, then the original error.
 *
 * The code is locale-neutral on purpose — it is the same token the API and the
 * logs use, so a user can quote it in a report. The provider's own text is
 * never dropped or summarized; diagnosing a failure needs what actually came
 * back from the endpoint.
 */
export function formatRunFailure(code: RunFailureCode | undefined, error: string): string {
  const detail = error.trim();
  if (!code) return detail;
  return detail ? `[${code}] ${detail}` : `[${code}]`;
}
