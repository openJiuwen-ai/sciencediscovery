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

/**
 * The sentinel the service stores for a session nobody has named yet.
 *
 * Repeated here rather than imported from `@sciencediscovery/schema` on
 * purpose: this app reaches the schema for types only, which is what keeps its
 * runtime out of the browser bundle (`api/types.ts` says so). A value import
 * would pull the whole barrel in to compare two strings.
 */
const UNTITLED_SESSION_TITLE = "Untitled session";

/**
 * A session's title as the sidebar row and the session bar print it.
 *
 * The sentinel is an English sentence stored as data, so printing it verbatim
 * would leave one English line in a Chinese interface (and a Chinese line in an
 * English one, for sessions created before this check existed). Both the
 * sentinel and an empty title stand for the same thing — this session has no
 * name yet — and both are shown in the interface language.
 */
export function sessionTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed === "" || trimmed === UNTITLED_SESSION_TITLE ? TEXT.sessionBar.untitled : title;
}
