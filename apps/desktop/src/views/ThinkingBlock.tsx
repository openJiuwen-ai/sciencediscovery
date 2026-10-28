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

import { thinkingSteps } from "../run-stream/model.js";
import { TEXT } from "../text.js";
import { collapseHint } from "./collapse-hint.js";

/**
 * The model's reasoning, folded away.
 *
 * Closed by default — the prototype's rule is that the answer body is the only
 * thing that starts open — but the summary still says 生成中 while tokens are
 * arriving, so a long think is visibly doing something rather than looking
 * stalled.
 *
 * The step count is an approximation. `assistant.thinking.delta` is one
 * undivided character stream with no step boundaries on the wire, so a blank
 * line is the only break the model emits on purpose. See `thinkingSteps`.
 */
export function ThinkingBlock({
  live,
  text,
  truncated,
}: {
  live: boolean;
  text: string;
  truncated: boolean;
}) {
  const steps = thinkingSteps(text);
  if (steps.length === 0 && !live) return null;
  return (
    <details className="msg-collapse thinking">
      <summary>
        <span aria-hidden="true" className="collapse-icon">✳</span>
        <span className="collapse-title">
          {TEXT.conversation.thinking}
          {steps.length > 0 ? ` · ${TEXT.conversation.thinkingSteps(steps.length)}` : ""}
        </span>
        <span className={`collapse-meta${live ? " is-live" : ""}`} {...collapseHint()}>
          {live ? TEXT.conversation.running : ""}
        </span>
        <span aria-hidden="true" className="collapse-chev">›</span>
      </summary>
      {truncated ? <div className="collapse-body">{TEXT.conversation.truncatedThinking}</div> : null}
      <ol className="thinking-list">
        {steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
    </details>
  );
}
