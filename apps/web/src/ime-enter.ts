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

/** The part of a keydown this rule reads. React keeps the composition flag on
 *  `nativeEvent`, and some IMEs report the candidate-confirming Enter only as
 *  `keyCode` 229, so a call site passes the event as it received it. */
export interface EnterKeydown {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
}

/**
 * Whether this keydown is an Enter the user meant, rather than the Enter their
 * IME used to accept a candidate. While a composition is open the key belongs
 * to the IME: acting on it sends the half-typed message (or picks a skill, or
 * commits a rename) with the pinyin still in it.
 *
 * Shift handling stays with each call site, because it differs: the composer
 * reads Shift+Enter as a newline, the single-line rename and dialog fields do
 * not.
 */
export function commitsOnEnter(event: EnterKeydown): boolean {
  // Stub of today's call-site predicate: the composition guards land with the
  // fix, and the tests beside this file state the contract they have to meet.
  return event.key === "Enter";
}
