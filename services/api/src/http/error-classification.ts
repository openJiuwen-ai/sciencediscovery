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
 * Legacy validators still throw plain Error objects. Keep their established
 * 400 responses while allowing genuinely unclassified faults to surface as
 * 500. New handlers should prefer ApiStatusError or a stable error code.
 */
export function isKnownClientInputError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  if (!(error instanceof Error)) return false;
  return [
    /\bis required\b/i,
    /\bmust\b/i,
    /\bcontains? an unknown value\b/i,
    /\bcannot\b/i,
    /\bdoes not match\b/i,
    /\binvalid\b/i,
    /\bunsafe\b.*\b(?:archive|package|path)\b/i,
    /\bplain basename\b/i,
  ].some((pattern) => pattern.test(error.message));
}
