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

import type { ApprovalMode } from "../api/types.js";
import type { CreateSessionRequest } from "../api/types.js";

/**
 * The permission mode the reader chose last, for new conversations in this run.
 *
 * #1204 asks that a new conversation start in the mode the reader last picked,
 * while conversations that already exist keep their own. The choice therefore
 * lives here, in the running application instance — not in storage: it is
 * deliberately not restored after a restart, and nothing reads it for a session
 * that already exists.
 */
let lastSelected: ApprovalMode | undefined;

export function rememberApprovalMode(mode: ApprovalMode): void {
  lastSelected = mode;
}

/** The mode a new conversation starts in, or `undefined` to let the service default. */
export function inheritedApprovalMode(): ApprovalMode | undefined {
  return lastSelected;
}

/**
 * The body for creating a conversation: an explicit model choice when the reader
 * made one, plus the inherited permission mode. Both are creation-time values;
 * the second never touches an existing session.
 */
export function newSessionRequest(explicitModelId?: string): CreateSessionRequest {
  const approvalMode = inheritedApprovalMode();
  return {
    ...(explicitModelId ? { modelId: explicitModelId } : {}),
    ...(approvalMode ? { approvalMode } : {}),
  };
}

/** Tests only: the preference is process-wide, so a test must start from none. */
export function resetApprovalModePreference(): void {
  lastSelected = undefined;
}
