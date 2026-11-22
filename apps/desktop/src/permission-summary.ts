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

import { formatPermissionDescription, normalizePermissionDescription } from "@sciencediscovery/schema";

import type { PermissionRequest } from "./api/types.js";
import { TEXT } from "./text.js";

/** The approval sentence for the language in force (#1305).
 *
 * The server sends the request as fields, not as a finished sentence: `summary`
 * is the canonical English statement, kept for the audit trail and for clients
 * that cannot compose one. A request recorded before that field existed, or
 * sent by a client that supplies only `summary`, still gets a readable card —
 * the localized action name rather than an English sentence in a Chinese
 * interface. Reading `TEXT` here (not at module scope) is what lets a replayed
 * request follow a language switch.
 */
export function formatPermissionRequest(
  request: Pick<PermissionRequest, "action" | "description" | "summary">,
): string {
  const description = normalizePermissionDescription(request.description);
  if (description) return formatPermissionDescription(description, TEXT.permission.description);
  const actions = TEXT.permission.actions;
  if (Object.hasOwn(actions, request.action)) return actions[request.action as keyof typeof actions];
  return request.summary;
}
