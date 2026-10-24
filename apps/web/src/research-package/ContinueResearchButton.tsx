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


import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api.js";

/** The request key survives reloads and transport errors; a failed operation gets a new key. */
export function ContinueResearchButton({ client, sessionId, disabled, onCreated }: { client: ApiClient; sessionId: string; disabled?: boolean; onCreated: (sessionIds: string[], entrySessionId: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const continueResearch = async () => {
    if (running.current || disabled) return;
    running.current = true; setBusy(true); setError(undefined);
    const key = `research-continuation:${sessionId}`;
    try {
      const requestId = localStorage.getItem(key) ?? crypto.randomUUID();
      localStorage.setItem(key, requestId);
      let operation = await client.createResearchContinuation(sessionId, requestId);
      while (operation.state === "copying" && mounted.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        if (!mounted.current) return;
        operation = await client.getResearchContinuation(sessionId, operation.id);
      }
      if (!mounted.current) return;
      if (operation.state === "failed") {
        localStorage.removeItem(key);
        throw new Error(operation.error || "复制未完成，请重试。");
      }
      if (!operation.entrySessionId || !operation.sessionIds?.length) throw new Error("复制结果缺少会话信息，请重试查询。");
      await onCreated(operation.sessionIds, operation.entrySessionId);
      localStorage.removeItem(key);
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "创建研究会话失败，请重试。"); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  return <div className="research-continuation-action" aria-busy={busy}>
    <button className="secondary-button compact-button" disabled={disabled || busy} onClick={() => void continueResearch()} type="button">{busy ? "正在复制研究记录…" : "创建新会话继续研究"}</button>
    {busy ? <span className="muted" role="status">完整恢复并核对内容后将打开新会话；关闭后可从快照继续查看进度。</span> : null}
    {error ? <span className="research-export-error" role="alert">{error}</span> : null}
  </div>;
}
