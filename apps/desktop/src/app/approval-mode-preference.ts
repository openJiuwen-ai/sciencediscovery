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

import type { ApprovalMode, CreateSessionRequest } from "../api/types.js";
import { APPROVAL_MODE_STORAGE_KEY, readStoredText, writeStoredText, type ReadableStorage } from "../state/storage.js";

/**
 * The permission mode new conversations start in (#1204).
 *
 * The choice is the reader's last explicit selection and it outlives a restart, so
 * desktop storage is the source of truth rather than a module variable. It is read
 * only when a conversation is created; no code path here writes it onto a session
 * that already exists.
 */
const MODES: readonly ApprovalMode[] = ["ask_for_dangerous", "always_allow"];

function isApprovalMode(value: string | null): value is ApprovalMode {
  return value !== null && (MODES as readonly string[]).includes(value);
}

function browserStorage(): ReadableStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // A blocked storage (private mode, a restrictive webview) means "no preference",
    // not a failed render: the service default still applies.
    return undefined;
  }
}

export function rememberApprovalMode(mode: ApprovalMode, storage: ReadableStorage | undefined = browserStorage()): void {
  if (storage) writeStoredText(storage, APPROVAL_MODE_STORAGE_KEY, mode);
}

/** The remembered mode, or `undefined` when nothing valid was stored. */
export function inheritedApprovalMode(storage: ReadableStorage | undefined = browserStorage()): ApprovalMode | undefined {
  const stored = storage ? readStoredText(storage, APPROVAL_MODE_STORAGE_KEY) : null;
  return isApprovalMode(stored) ? stored : undefined;
}

/**
 * The body for creating a conversation: an explicit model choice when the reader
 * made one, plus the remembered permission mode. Both are creation-time values;
 * the second never touches an existing session.
 */
export function newSessionRequest(explicitModelId?: string,
  storage: ReadableStorage | undefined = browserStorage()): CreateSessionRequest {
  const approvalMode = inheritedApprovalMode(storage);
  return {
    ...(explicitModelId ? { modelId: explicitModelId } : {}),
    ...(approvalMode ? { approvalMode } : {}),
  };
}

/**
 * Apply the remembered mode to a session created by another path (a new project's
 * first conversation), which the service creates with its own default. Returns
 * whether anything was applied; the caller passes its own update function so this
 * module stays free of API plumbing.
 */
export async function inheritForSession(sessionId: string,
  update: (sessionId: string, body: { approvalMode: ApprovalMode }) => Promise<unknown>,
  storage: ReadableStorage | undefined = browserStorage()): Promise<boolean> {
  const approvalMode = inheritedApprovalMode(storage);
  if (!approvalMode) return false;
  await update(sessionId, { approvalMode });
  return true;
}

/** Tests only: drop the stored preference. */
export function resetApprovalModePreference(storage: ReadableStorage | undefined = browserStorage()): void {
  try { storage?.removeItem?.(APPROVAL_MODE_STORAGE_KEY); } catch { /* nothing to reset */ }
}
