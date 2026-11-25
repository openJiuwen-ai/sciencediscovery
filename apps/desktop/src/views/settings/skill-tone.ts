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

/** The five tones the handoff draws for a Skill's mark. Which package gets
 *  which is not a property the server sends, so the name picks one and a page
 *  keeps its colors across reads. */
export const MARK_TONES = ["blue", "green", "amber", "violet", "pink"] as const;

export function markTone(name: string): (typeof MARK_TONES)[number] {
  let total = 0;
  for (const char of name) total += char.codePointAt(0) ?? 0;
  return MARK_TONES[total % MARK_TONES.length]!;
}
