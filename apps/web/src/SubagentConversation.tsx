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

import type { ComposerReference, Subagent } from "@sciencediscovery/schema";
import { useEffect, useMemo, useRef, useState } from "react";

import { BrandIcon, ChevronDownIcon, ChevronRightIcon, WarningIcon } from "./icons.js";
import { MarkdownRenderer } from "./Markdown.js";
import { RunTimeline, type RunTimelineEntry } from "./timeline/RunTimeline.js";

const TURN_STARTED = /^Turn (\d+) started$/i;

/** Project a persisted SubAgent child stream into the same timeline used by the main Agent. */
export function subagentTimelineEntries(subagent: Subagent): RunTimelineEntry[] {
  const entries: RunTimelineEntry[] = [];
  let turn = 1;

  for (const step of subagent.steps) {
    if (step.kind === "system") {
      const marker = TURN_STARTED.exec(step.content.trim());
      if (marker) turn = Number(marker[1]);
      continue;
    }

    const status = step.status ?? "completed";
    const id = `subagent-${subagent.id}-${step.id}`;
    if (step.kind === "thinking") {
      entries.push({
        content: step.content,
        expanded: status === "running",
        id,
        status: status === "running" ? "running" : "completed",
        turn,
        type: "thinking",
      });
      continue;
    }

    if (step.kind === "tool") {
      entries.push({
        expanded: status === "running",
        id,
        trace: {
          id: `${subagent.id}:${step.toolCallId ?? step.id}`,
          ...(step.input !== undefined ? { input: step.input } : {}),
          name: step.toolName ?? "tool",
          ...(status === "running" ? {} : { output: step.content }),
          status,
        },
        type: "tool",
      });
      continue;
    }

    entries.push({ content: step.content, id, type: "assistant" });
  }

  return entries;
}

function subagentModelLabel(subagent: Subagent): string {
  return subagent.model?.name ?? subagent.model?.model ?? "Model unavailable";
}

function subagentUsageLabel(subagent: Subagent): string {
  if (!subagent.usage) return "Usage unavailable";
  return `${subagent.usage.totalTokens.toLocaleString()} tokens · ${subagent.usage.inputTokens.toLocaleString()} in / ${subagent.usage.outputTokens.toLocaleString()} out`;
}

export function SubagentConversation({
  loadWorkspaceImage,
  onBack,
  onChipClick,
  onOpenArtifacts,
  projectName,
  references,
  sessionTitle,
  specialistName,
  subagent,
  workspaceSessionId,
}: {
  loadWorkspaceImage?: (path: string, signal: AbortSignal) => Promise<Blob>;
  onBack: () => void;
  onChipClick?: (reference: ComposerReference) => void;
  onOpenArtifacts?: () => void;
  projectName: string;
  references?: ComposerReference[];
  sessionTitle: string;
  specialistName?: string;
  subagent: Subagent;
  workspaceSessionId?: string;
}) {
  const baseEntries = useMemo(() => subagentTimelineEntries(subagent), [subagent]);
  const [expansion, setExpansion] = useState<{
    entries: Record<string, boolean>;
    subagentId: string;
  }>(() => ({ entries: {}, subagentId: subagent.id }));
  const currentExpansion = expansion.subagentId === subagent.id ? expansion.entries : {};
  const entries = baseEntries.map((entry): RunTimelineEntry => {
    if (entry.type !== "thinking" && entry.type !== "tool") return entry;
    const expanded = currentExpansion[entry.id];
    return expanded === undefined ? entry : { ...entry, expanded };
  });
  const messagesViewport = useRef<HTMLDivElement>(null);
  const [isFollowingOutput, setIsFollowingOutput] = useState(true);

  useEffect(() => {
    if (!isFollowingOutput) return;
    const viewport = messagesViewport.current;
    viewport?.scrollTo({ top: viewport.scrollHeight });
  }, [baseEntries, isFollowingOutput, subagent.error, subagent.status]);

  function handleMessagesScroll(): void {
    const viewport = messagesViewport.current;
    if (!viewport) return;
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setIsFollowingOutput(distanceFromBottom < 80);
  }

  function scrollToLatest(): void {
    setIsFollowingOutput(true);
    const viewport = messagesViewport.current;
    viewport?.scrollTo({ behavior: "smooth", top: viewport.scrollHeight });
  }

  const roleLabel = specialistName ? `SubAgent · ${specialistName}` : "SubAgent";
  return <section aria-label={`SubAgent: ${subagent.input.description}`} className="conversation subagent-conversation">
    <header className="session-bar subagent-session-bar">
      <div className="subagent-session-bar-title">
        <button aria-label="Back to main Agent" className="icon-button subagent-back-button" onClick={onBack} title="Back to main Agent" type="button"><ChevronRightIcon size={17} /></button>
        <div className="session-bar-title">
          <span className="session-bar-project" title={projectName}>{projectName}</span>
          <span aria-hidden="true" className="session-bar-sep">›</span>
          <span className="subagent-parent-session" title={sessionTitle}>{sessionTitle}</span>
          <span aria-hidden="true" className="session-bar-sep">›</span>
          <h1 className="session-bar-session" title={subagent.input.description}><span>{subagent.input.description}</span></h1>
        </div>
      </div>
      <div className="subagent-page-meta">
        <span title={subagentModelLabel(subagent)}>{subagentModelLabel(subagent)}</span>
        <span>{subagent.turnCount}/{subagent.maxTurns} turns</span>
        <span title={subagentUsageLabel(subagent)}>{subagentUsageLabel(subagent)}</span>
        <em className={subagent.status}>{subagent.status}</em>
      </div>
    </header>

    <div className="messages subagent-messages" onScroll={handleMessagesScroll} ref={messagesViewport}>
      <article className="message user subagent-prompt-message">
        <div className="avatar"><BrandIcon size={18} /></div>
        <div>
          <span className="message-role">Coordinator</span>
          <MarkdownRenderer className="message-content" content={subagent.input.prompt} />
        </div>
      </article>
      <RunTimeline
        agentLabel={roleLabel}
        entries={entries}
        isRunning={subagent.status === "running"}
        loadWorkspaceImage={loadWorkspaceImage}
        modelName={subagent.model?.name ?? subagent.model?.model}
        onChipClick={onChipClick}
        onOpenArtifacts={onOpenArtifacts}
        onToggle={(id, expanded) => setExpansion((current) => ({
          entries: {
            ...(current.subagentId === subagent.id ? current.entries : {}),
            [id]: expanded,
          },
          subagentId: subagent.id,
        }))}
        references={references}
        workspaceSessionId={workspaceSessionId}
      />
      {!entries.length ? <div className="subagent-empty-state"><strong>{subagent.status === "running" ? "SubAgent is starting" : "No SubAgent activity was recorded"}</strong></div> : null}
      {subagent.error ? <aside className="boundary-note subagent-page-error"><span><WarningIcon size={15} /></span><p>{subagent.error}</p></aside> : null}
      {!isFollowingOutput ? <div className="follow-output-dock"><button className="follow-output-button" onClick={scrollToLatest} type="button">Latest activity <ChevronDownIcon size={15} /></button></div> : null}
    </div>
  </section>;
}
