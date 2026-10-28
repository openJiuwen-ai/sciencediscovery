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

import type { ApiClient } from "../api/client.js";
import { readToolOutput } from "../api/stream.js";
import type { ToolTrace } from "../api/types.js";
import { formatToolInput, parseToolResultSections, type ToolDetail } from "../app/tool-io.js";
import { TEXT } from "../text.js";
import { collapseHint } from "./collapse-hint.js";
import { ToolIoBlock } from "./ToolIoBlock.js";

function statusLabel(trace: ToolTrace): string {
  if (trace.status === "running") return trace.name;
  return trace.status === "failed" ? TEXT.conversation.toolFailed(trace.name) : TEXT.conversation.toolCompleted(trace.name);
}

/**
 * One tool call, rendered in the place the model made it.
 *
 * The result is *not* in the run state: it lives in a substream of its own and
 * is read here, once, when the card is first opened. Three sources are tried in
 * order — the trace's own inline copy (pre-stream records carry one), the
 * substream, then the trace's `summary` — because a run read back from
 * `?after=0` has the trace but never the body.
 *
 * What has already been read is remembered per `stream:status`, so folding the
 * card shut and open again costs nothing, while a call that was still running
 * when it was opened is read a second time once it completes. A failed read is
 * remembered too, deliberately: the placeholder then says the result is
 * unavailable rather than retrying against a server that is already
 * misbehaving on every toggle, and reopening the session starts clean.
 */
export function ToolCard({
  authorized,
  client,
  onOpenTool,
  runId,
  sessionId,
  trace,
}: {
  /** An `allow` decision covered this call, which is worth saying: it is the
   *  difference between "the tool ran" and "the tool ran because you said so". */
  authorized: boolean;
  client: ApiClient;
  /** Hand one input or result block to the right panel. Absent where there is
   *  no panel — the block then shows its clipped text and is not a door. */
  onOpenTool?: (detail: ToolDetail) => void;
  runId?: string;
  sessionId?: string;
  trace: ToolTrace;
}) {
  const [open, setOpen] = useState(false);
  const [fetched, setFetched] = useState<string>();
  const [loaded, setLoaded] = useState<string>();
  const [unreadable, setUnreadable] = useState(false);

  const streamId = trace.outputStream;
  useEffect(() => {
    if (!open || trace.output !== undefined || streamId === undefined) return;
    if (runId === undefined || sessionId === undefined) return;
    const key = `${streamId}:${trace.status}`;
    if (loaded === key) return;
    let cancelled = false;
    void readToolOutput(client, sessionId, runId, streamId)
      .then((text) => {
        if (cancelled) return;
        setFetched(text);
        setLoaded(key);
        setUnreadable(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoaded(key);
        setUnreadable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, loaded, open, runId, sessionId, streamId, trace.output, trace.status]);

  const inputText = formatToolInput(trace);
  const outputText = trace.output ?? fetched ?? trace.summary;
  const sections = outputText === undefined || outputText === ""
    ? []
    : parseToolResultSections(outputText, trace.status);

  const renderBlock = (id: string, label: string, content: string) => (
    <ToolIoBlock
      content={content}
      key={id}
      label={label}
      onOpen={onOpenTool === undefined
        ? undefined
        : () => onOpenTool({ content, id, label, name: trace.name, status: trace.status, toolId: trace.id })}
    />
  );

  return (
    <details
      className={`msg-collapse tool-card is-${trace.status}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary>
        <span className="collapse-icon">{trace.status === "running" ? "◇" : trace.status === "failed" ? "!" : "✓"}</span>
        <span className="collapse-title">{statusLabel(trace)}</span>
        <span className="collapse-meta" {...collapseHint()}>{TEXT.conversation.toolCall}</span>
        {authorized ? <span className="tool-authorized">{TEXT.conversation.authorized}</span> : null}
        <span aria-hidden="true" className="collapse-chev">›</span>
      </summary>
      <div className="collapse-body tool-io-sections">
        {inputText !== undefined && inputText !== "" ? renderBlock("input", TEXT.conversation.toolInput, inputText) : null}
        {trace.inputTruncated ? <p className="tool-io-note">{TEXT.conversation.inputTruncated}</p> : null}
        {sections.length > 0
          ? sections.map((section) => renderBlock(section.id, section.label, section.content))
          : (
            <p className="tool-io-note">{trace.status === "running"
              ? TEXT.conversation.toolRunning
              : unreadable
                ? TEXT.conversation.resultUnavailable
                : streamId !== undefined
                  ? TEXT.conversation.loadingResult
                  : TEXT.conversation.noOutput}</p>
          )}
        {trace.outputTruncated ? <p className="tool-io-note">{TEXT.conversation.outputTruncated}</p> : null}
      </div>
    </details>
  );
}
