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

import { useEffect, useState } from "react";
import { useLocale } from "../i18n/index.js";

// -1 means created but not yet opened. Keep expired deadlines so reopening an
// idempotently created copy never repeats the notice. Fall back if storage is blocked.
const deadlines = new Map<string, number>();
const storageKey = (sessionId: string) => `research-copy-notice:${sessionId}`;
function readDeadline(sessionId: string): number {
  try { return Number(sessionStorage.getItem(storageKey(sessionId))) || deadlines.get(sessionId) || 0; }
  catch { return deadlines.get(sessionId) || 0; }
}
function saveDeadline(sessionId: string, value: number): void {
  deadlines.set(sessionId, value);
  try { sessionStorage.setItem(storageKey(sessionId), String(value)); } catch { /* In-memory fallback. */ }
}

export function markResearchCopyCreated(sessionId: string): void {
  if (!readDeadline(sessionId)) saveDeadline(sessionId, -1);
}

export function ResearchCopyNotice({ sessionId }: { sessionId: string }) {
  const { t } = useLocale();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let deadline = readDeadline(sessionId);
    if (deadline === -1) {
      deadline = Date.now() + 10_000;
      saveDeadline(sessionId, deadline);
    }
    const remaining = deadline - Date.now();
    setVisible(remaining > 0);
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setVisible(false), remaining);
    return () => window.clearTimeout(timer);
  }, [sessionId]);
  return visible ? <div className="research-snapshot-banner" role="status">{t("researchCopy.originNotice")}</div> : null;
}
