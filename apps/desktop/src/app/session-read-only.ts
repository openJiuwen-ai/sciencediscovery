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

import { isEvidenceSessionReadOnly } from "@sciencediscovery/schema";
import type { SessionDetail } from "../api/types.js";

/** Why a Session's composer is inert. */
export type SessionReadOnly = "archived" | "evidence";

/**
 * Whether the open Session takes input, and why not.
 *
 * Two unrelated causes look the same in the UI — no message, no upload, no
 * research — so they are decided in one place rather than by each call site
 * repeating `archivedAt !== undefined || isEvidenceSessionReadOnly(...)`:
 *
 * - **archived**: the user archived it. The server refuses writes, and the
 *   reader gets a banner and a disabled composer. Restoring clears it.
 * - **evidence**: an imported read-only snapshot. It stays read-only until it
 *   is copied into an independent Session.
 *
 * Archived is answered first: an archived evidence import is still archived,
 * and that is the state the reader can undo from the sidebar.
 */
export function sessionReadOnly(detail: SessionDetail | undefined): SessionReadOnly | undefined {
  if (detail === undefined) return undefined;
  if (detail.archivedAt !== undefined) return "archived";
  if (isEvidenceSessionReadOnly(detail)) return "evidence";
  return undefined;
}
