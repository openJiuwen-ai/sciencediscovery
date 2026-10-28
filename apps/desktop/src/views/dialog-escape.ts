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
 * Whether this keydown is an Escape nobody has claimed yet.
 *
 * Dialogs stack, and their listeners are on different nodes: the settings
 * dialog listens on `window`, while the confirmation it opens listens on
 * `document`, which the key reaches first on its way up. The topmost dialog
 * claims the key by calling `preventDefault`; this rule is how every dialog
 * below it sees that claim and stays open. Without it one Escape closes the
 * confirmation *and* the settings behind it, which is the opposite of what a
 * stacked dialog is for.
 *
 * Only the two fields the rule reads are asked for, so it can be tested
 * without a DOM, the way the rest of this app's view rules are.
 */
export function claimsEscape(event: { defaultPrevented: boolean; key: string }): boolean {
  return event.key === "Escape" && !event.defaultPrevented;
}
