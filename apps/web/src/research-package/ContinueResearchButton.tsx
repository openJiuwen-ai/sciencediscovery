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


import type { ApiClient } from "../api.js";
import { useResearchContinuationContext } from "./ResearchContinuationTasks.js";

/** The request key survives reloads and transport errors; a failed operation gets a new key. */
export function ContinueResearchButton({ sessionId, disabled }: { client: ApiClient; sessionId: string; disabled?: boolean; onCreated: (sessionIds: string[], entrySessionId: string) => Promise<void> }) {
  const context = useResearchContinuationContext();
  const busy = context?.tasks.some((task) => task.sourceSessionId === sessionId && task.state === "copying");
  return <div className="research-continuation-action" aria-busy={busy}>
    <button className="secondary-button compact-button" disabled={disabled || busy || !context} onClick={() => context?.manager.start(sessionId)} type="button">{busy ? "正在复制研究记录…" : "创建新会话继续研究"}</button>
    {busy ? <span className="muted" role="status">任务在后台继续，切换会话后仍可查看进度。</span> : null}
  </div>;
}
