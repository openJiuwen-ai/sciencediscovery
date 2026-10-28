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

import { TEXT } from "../text.js";
import { untitled } from "./session-order.js";

/**
 * A session's title as the interface prints it — the sidebar row, the session
 * bar, the rename field, and the deletion the user is asked to confirm.
 *
 * It lives in `app` rather than beside those views because `use-workspace`
 * needs it too: the delete confirmation names the Session, and a raw sentinel
 * there would put one English line in a Chinese dialog.
 *
 * The sentinel is an English sentence stored as data, so printing it verbatim
 * would leave that English line behind (and a Chinese one in an English
 * interface, for sessions created before this check existed). Both the sentinel
 * and an empty title stand for the same thing — this session has no name yet —
 * and both are shown in the interface language.
 */
export function sessionTitle(title: string): string {
  return untitled(title) ? TEXT.sessionBar.untitled : title;
}
