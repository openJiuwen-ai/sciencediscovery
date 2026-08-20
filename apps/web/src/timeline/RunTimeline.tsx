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

import type {
  ArtifactReviewRun,
  ComposerReference,
  PermissionDecision,
  PermissionRequest,
  RunStreamEvent,
  ToolTrace,
} from "@sciencediscovery/schema";
import React, { useEffect, useRef, useState } from "react";

import { BrandIcon, CheckIcon, ChevronRightIcon, SpinnerIcon, WarningIcon } from "../icons.js";
import { MarkdownRenderer } from "../Markdown.js";
import { PermissionDecisionActions, permissionMatchingKey } from "../PermissionDecisionActions.js";
import { mergePermissionRequestSnapshot } from "../permission-state.js";
import { ReviewerPanel } from "../ReviewerPanel.js";
import { ToolIoSections } from "./ToolIoSections.js";
import { useLocale } from "../i18n/index.js";
import { formatRunFailure } from "../run-failure.js";

// Memory-graph tools are internal bookkeeping: the LLM uses them to read the
// graph and record claims/evidence while composing the report, but they are
// not work the user asked to see. Hide their tool cards so the timeline shows
// the report-writing work, not the graph plumbing behind it.
const GRAPH_TOOL_NAMES = new Set(["query_graph", "declare_evidence", "declare_claim"]);

function isGraphToolTrace(trace: ToolTrace): boolean {
  return GRAPH_TOOL_NAMES.has(trace.name);
}

export type RunTimelineEntry =
  | {
      content: string;
      expanded: boolean;
      id: string;
      status: "completed" | "running";
      truncated?: boolean;
      turn: number;
      type: "thinking";
    }
  | {
      expanded: boolean;
      id: string;
      trace: ToolTrace;
      type: "tool";
    }
  | {
      content: string;
      id: string;
      /** Chip references the run.completed message carried. Filled when the
       * terminal event arrives so the assistant entry renders [alias] chips
       * from the message's own references rather than the session-wide
       * `references` prop (which picks one report file and can mismatch when
       * a run has several report-kind outputs). Undefined during streaming
       * and on entries built from assistant.delta before run.completed. */
      references?: ComposerReference[];
      truncated?: boolean;
      type: "assistant";
    }
  | {
      droppedEvents: number;
      id: string;
      type: "history-truncated";
    }
  | {
      id: string;
      request: PermissionRequest;
      type: "permission";
    };

function finishThinking(entries: RunTimelineEntry[]): RunTimelineEntry[] {
  return entries
    .map((entry) => entry.type === "thinking" && entry.status === "running"
      ? { ...entry, expanded: false, status: "completed" }
      : entry)
    // Drop a thinking step that ended up with no reasoning text — it would
    // render as an empty "Thought process" card wedged between assistant
    // turns, and its presence also blocks the next assistant delta from
    // appending to the previous assistant message.
    .filter((entry): boolean => !(entry.type === "thinking" && entry.status === "completed" && !entry.content.trim())) as RunTimelineEntry[];
}

function nextAnswerId(entries: RunTimelineEntry[]): string {
  return `answer-${entries.filter((entry) => entry.type === "assistant").length + 1}`;
}

function nextThinkingId(entries: RunTimelineEntry[], turn: number): string {
  const segment = entries.filter((entry) => entry.type === "thinking" && entry.turn === turn).length + 1;
  return segment === 1 ? `thinking-${turn}` : `thinking-${turn}-${segment}`;
}

/** Keep streamed agent activity in the exact order in which each step started. */
export function reduceRunTimeline(
  entries: RunTimelineEntry[],
  event: RunStreamEvent,
): RunTimelineEntry[] {
  if (event.type === "agent.phase") {
    const finished = finishThinking(entries);
    const last = finished.at(-1);
    if (last?.type === "thinking" && last.turn === event.turn) {
      return finished.map((entry, index) => index === finished.length - 1 && entry.type === "thinking"
        ? { ...entry, expanded: true, status: "running" }
        : entry);
    }
    return [...finished, {
      content: "",
      expanded: true,
      id: nextThinkingId(finished, event.turn),
      status: "running",
      turn: event.turn,
      type: "thinking",
    }];
  }

  if (event.type === "assistant.thinking.delta") {
    const last = entries.at(-1);
    if (last?.type === "thinking" && last.turn === event.turn) {
      return entries.map((entry, entryIndex) => entryIndex === entries.length - 1 && entry.type === "thinking"
        ? { ...entry, content: entry.content + event.delta, expanded: true, status: "running" }
        : entry);
    }
    const finished = finishThinking(entries);
    return [...finished, {
      content: event.delta,
      expanded: true,
      id: nextThinkingId(finished, event.turn),
      status: "running",
      turn: event.turn,
      type: "thinking",
    }];
  }

  if (event.type === "assistant.thinking.snapshot") {
    const finished = finishThinking(entries);
    const last = finished.at(-1);
    if (last?.type === "thinking" && last.turn === event.turn) {
      return finished.map((entry, entryIndex) => entryIndex === finished.length - 1 && entry.type === "thinking"
        ? {
            ...entry,
            content: event.content,
            ...(event.truncated ? { truncated: true } : {}),
          }
        : entry);
    }
    return [...finished, {
      content: event.content,
      expanded: false,
      id: nextThinkingId(finished, event.turn),
      status: "completed",
      ...(event.truncated ? { truncated: true } : {}),
      turn: event.turn,
      type: "thinking",
    }];
  }

  if (event.type === "tool.started") {
    const finished = finishThinking(entries);
    if (isGraphToolTrace(event.trace)) return finished;
    const index = finished.findIndex((entry) => entry.type === "tool" && entry.trace.id === event.trace.id);
    if (index >= 0) {
      return finished.map((entry, entryIndex) => entryIndex === index && entry.type === "tool"
        ? { ...entry, trace: event.trace }
        : entry);
    }
    return [...finished, {
      expanded: true,
      id: `tool-${event.trace.id}`,
      trace: event.trace,
      type: "tool",
    }];
  }

  if (event.type === "tool.completed") {
    if (isGraphToolTrace(event.trace)) return entries;
    const index = entries.findIndex((entry) => entry.type === "tool" && entry.trace.id === event.trace.id);
    if (index < 0) {
      return [...finishThinking(entries), {
        expanded: false,
        id: `tool-${event.trace.id}`,
        trace: event.trace,
        type: "tool",
      }];
    }
    // The completion event no longer repeats the arguments; carry the started
    // entry's arguments forward (older records that still ship them win the spread).
    return entries.map((entry, entryIndex) => entryIndex === index && entry.type === "tool"
      ? {
          ...entry,
          expanded: false,
          trace: {
            ...(entry.trace.args !== undefined ? { args: entry.trace.args } : {}),
            ...(entry.trace.input !== undefined
              ? { input: entry.trace.input, ...(entry.trace.inputTruncated ? { inputTruncated: true } : {}) }
              : {}),
            ...event.trace,
          },
        }
      : entry);
  }

  if (event.type === "assistant.delta") {
    const finished = finishThinking(entries);
    const last = finished.at(-1);
    if (last?.type === "assistant") {
      return finished.map((entry, index) => index === finished.length - 1 && entry.type === "assistant"
        ? { ...entry, content: entry.content + event.delta }
        : entry);
    }
    return [...finished, { content: event.delta, id: nextAnswerId(finished), type: "assistant" }];
  }

  if (event.type === "assistant.snapshot") {
    const finished = finishThinking(entries);
    const last = finished.at(-1);
    if (last?.type === "assistant") {
      return finished.map((entry, index) => index === finished.length - 1 && entry.type === "assistant"
        ? {
            ...entry,
            content: event.content,
            ...(event.truncated ? { truncated: true } : {}),
          }
        : entry);
    }
    return [...finished, {
      content: event.content,
      id: nextAnswerId(finished),
      ...(event.truncated ? { truncated: true } : {}),
      type: "assistant",
    }];
  }

  if (event.type === "permission.required" || event.type === "permission.resolved") {
    const finished = finishThinking(entries);
    const index = finished.findIndex((entry) => entry.type === "permission" && entry.request.id === event.request.id);
    if (index >= 0) {
      return finished.map((entry, entryIndex) => entryIndex === index && entry.type === "permission"
        ? { ...entry, request: mergePermissionRequestSnapshot(entry.request, event.request) }
        : entry);
    }
    return [...finished, {
      id: `permission-${event.request.id}`,
      request: event.request,
      type: "permission",
    }];
  }

  if (event.type === "run.history.truncated") {
    const existing = entries.findIndex((entry) => entry.type === "history-truncated");
    if (existing >= 0) {
      return entries.map((entry, index) => index === existing && entry.type === "history-truncated"
        ? { ...entry, droppedEvents: event.droppedEvents }
        : entry);
    }
    return [{
      droppedEvents: event.droppedEvents,
      id: "run-history-truncated",
      type: "history-truncated",
    }, ...entries];
  }

  if (event.type === "run.completed") {
    const finished = finishThinking(entries);
    const messageReferences = event.message.references;
    // Thread the message's own chip references onto the assistant entry that
    // carries the same report prose. The terminal message is the authoritative
    // source — updateMessageReferences back-fills it from the run's drained
    // chips — so prefer it over the session-wide `references` prop, which
    // resolves a single report file and mismatches when a run declares several
    // report-kind outputs (e.g. a leader delivery_summary alongside a
    // report-writer's squares_report).
    if (finished.some((entry) => entry.type === "assistant" && entry.content.trim())) {
      return finished.map((entry) => entry.type === "assistant" && messageReferences?.length
        ? { ...entry, references: messageReferences }
        : entry);
    }
    return [...finished, {
      content: event.message.content,
      id: nextAnswerId(finished),
      ...(messageReferences?.length ? { references: messageReferences } : {}),
      type: "assistant",
    }];
  }

  if (event.type === "run.failed" || event.type === "run.cancelled") {
    const summary = event.type === "run.failed"
      ? formatRunFailure(event.errorCode, event.error)
      : event.reason;
    return finishThinking(entries).map((entry) => {
      if (entry.type === "tool" && entry.trace.status === "running") {
        return { ...entry, expanded: false, trace: { ...entry.trace, status: "failed", summary } };
      }
      return cancelPendingPermission(entry);
    });
  }

  if (event.type === "run.status"
    && (event.status === "completed"
      || event.status === "failed"
      || event.status === "cancelled"
      || event.status === "interrupted")) {
    const summary = event.reason ?? event.run.error ?? `Run ${event.status}`;
    return finishThinking(entries).map((entry) => {
      if (entry.type === "tool" && entry.trace.status === "running" && event.status !== "completed") {
        return { ...entry, expanded: false, trace: { ...entry.trace, status: "failed", summary } };
      }
      return cancelPendingPermission(entry);
    });
  }

  return entries;
}

/**
 * A run past its terminal event can never decide its requests anymore — the
 * API cancels them on teardown. Replays recorded before that fix (or cut off
 * mid-teardown) still end with a pending card; normalize it so a refreshed
 * timeline never shows an undecidable pending approval.
 */
function cancelPendingPermission(entry: RunTimelineEntry): RunTimelineEntry {
  return entry.type === "permission" && entry.request.state === "pending"
    ? { ...entry, request: { ...entry.request, state: "cancelled" } }
    : entry;
}

export function setTimelineEntryExpanded(
  entries: RunTimelineEntry[],
  id: string,
  expanded: boolean,
): RunTimelineEntry[] {
  return entries.map((entry) => entry.id === id && (entry.type === "thinking" || entry.type === "tool")
    ? { ...entry, expanded }
    : entry);
}

function statusIcon(status: ToolTrace["status"] | "completed" | "running") {
  if (status === "running") return <SpinnerIcon size={14} />;
  if (status === "failed") return <WarningIcon size={14} />;
  return <CheckIcon size={14} />;
}

export function RunTimeline({
  artifactReviews = [],
  entries,
  isRunning,
  modelName,
  loadWorkspaceImage,
  onLoadToolOutput,
  onOpenArtifacts,
  onPermissionDecision,
  onToggle,
  references,
  onChipClick,
  reviewerLevel,
  workspaceSessionId,
}: {
  artifactReviews?: ArtifactReviewRun[];
  entries: RunTimelineEntry[];
  isRunning: boolean;
  modelName?: string;
  loadWorkspaceImage?: (path: string, signal: AbortSignal) => Promise<Blob>;
  /** Fetches the full result of a tool whose output lives in a child stream. */
  onLoadToolOutput?: (trace: ToolTrace) => Promise<string | undefined>;
  onOpenArtifacts?: () => void;
  onPermissionDecision?: (request: PermissionRequest, decision: PermissionDecision) => Promise<void>;
  onToggle: (id: string, expanded: boolean) => void;
  /** Chip references (alias → graph node) for the session's latest report
   * artifact version, so [evidence1]/[artifact1] tokens in assistant report messages
   * render as clickable chips inline. Absent on sessions without a report. */
  references?: ComposerReference[];
  onChipClick?: (reference: ComposerReference) => void;
  reviewerLevel?: "quick" | "smart" | "deep";
  workspaceSessionId?: string;
}) {
  const { locale, t } = useLocale();
  const [decidingPermissionIds, setDecidingPermissionIds] = useState<string[]>([]);
  const [decidingPermissionMatchers, setDecidingPermissionMatchers] = useState<string[]>([]);
  const [toolOutputs, setToolOutputs] = useState<Record<string, string>>({});
  const loadingToolIds = useRef(new Set<string>());
  useEffect(() => {
    if (!onLoadToolOutput) return;
    for (const entry of entries) {
      if (entry.type !== "tool" || !entry.expanded || entry.trace.status === "running") continue;
      const trace = entry.trace;
      if (!trace.outputStream || trace.output !== undefined) continue;
      if (toolOutputs[trace.id] !== undefined || loadingToolIds.current.has(trace.id)) continue;
      loadingToolIds.current.add(trace.id);
      void onLoadToolOutput(trace)
        .then((output) => setToolOutputs((current) => ({ ...current, [trace.id]: output ?? "" })))
        .finally(() => loadingToolIds.current.delete(trace.id));
    }
  }, [entries, onLoadToolOutput, toolOutputs]);
  if (!entries.length) return null;
  async function decidePermission(request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    if (!onPermissionDecision) return;
    const matcher = permissionMatchingKey(request);
    setDecidingPermissionIds((current) => [...current, request.id]);
    if (decision === "allow_matching") setDecidingPermissionMatchers((current) => [...current, matcher]);
    try {
      await onPermissionDecision(request, decision);
    } finally {
      setDecidingPermissionIds((current) => current.filter((id) => id !== request.id));
      if (decision === "allow_matching") {
        setDecidingPermissionMatchers((current) => {
          const index = current.indexOf(matcher);
          return index < 0 ? current : current.toSpliced(index, 1);
        });
      }
    }
  }
  return (
    <section className="run-timeline" aria-label={t("timeline.activity")} aria-live="polite">
      {entries.map((entry) => {
        if (entry.type === "history-truncated") {
          return (
            <aside className="boundary-note" key={entry.id}>
              <span><WarningIcon size={15} /></span>
              <p>{entry.droppedEvents} run event(s) were removed by the retention policy; approval records are kept.</p>
            </aside>
          );
        }

        if (entry.type === "permission") {
          const pending = entry.request.state === "pending";
          const status = pending ? t("permissions.required") : entry.request.state === "allowed"
            ? t("timeline.permissionGranted")
            : entry.request.state === "denied" ? t("timeline.permissionDenied") : t("timeline.permissionCancelled");
          return (
            <article className={`permission-card timeline-permission ${entry.request.state}`} key={entry.id}>
              <div>
                <span className="eyebrow">{status}</span>
                <h4>{entry.request.summary}</h4>
                <code>{entry.request.resource}</code>
                {!pending && entry.request.decidedAt ? <small>{t("timeline.decided")} {new Date(entry.request.decidedAt).toLocaleString(locale)}</small> : null}
                <details className="permission-details">
                  <summary>{t("timeline.details")}</summary>
                  <dl>
                    <dt>{t("timeline.action")}</dt><dd><code>{entry.request.action}</code></dd>
                    <dt>{t("timeline.resource")}</dt><dd><code>{entry.request.resource}</code></dd>
                    <dt>{t("timeline.requested")}</dt><dd>{new Date(entry.request.createdAt).toLocaleString(locale)}</dd>
                    {entry.request.decision ? <><dt>{t("timeline.decision")}</dt><dd>{entry.request.decision}</dd></> : null}
                    {entry.request.decidedAt ? <><dt>{t("timeline.decided")}</dt><dd>{new Date(entry.request.decidedAt).toLocaleString(locale)}</dd></> : null}
                    {entry.request.executionId ? <><dt>{t("timeline.execution")}</dt><dd><code>{entry.request.executionId}</code></dd></> : null}
                    {entry.request.toolCallId ? <><dt>{t("timeline.toolCall")}</dt><dd><code>{entry.request.toolCallId}</code></dd></> : null}
                  </dl>
                </details>
              </div>
              {pending && isRunning && onPermissionDecision ? (
                <PermissionDecisionActions
                  busy={decidingPermissionIds.includes(entry.request.id)
                    || decidingPermissionMatchers.includes(permissionMatchingKey(entry.request))}
                  onDecision={(decision) => void decidePermission(entry.request, decision)}
                />
              ) : null}
            </article>
          );
        }

        if (entry.type === "assistant") {
          return (
            <article className="message assistant streaming" key={entry.id}>
              <div className="avatar"><BrandIcon size={19} /></div>
              <div>
                <span className="message-role">ScienceDiscovery{modelName ? ` · ${modelName}` : ""}</span>
                <MarkdownRenderer
                  className="message-content"
                  content={entry.content}
                  loadWorkspaceImage={loadWorkspaceImage}
                  onChipClick={onChipClick}
                  onOpenArtifacts={onOpenArtifacts}
                  references={entry.references ?? references}
                  workspaceSessionId={workspaceSessionId}
                />
                {entry.truncated ? <p className="muted">Earlier replay text was truncated by the retention policy.</p> : null}
                {isRunning && entries.at(-1)?.id === entry.id ? <span className="cursor" /> : null}
              </div>
            </article>
          );
        }

        if (entry.type === "thinking") {
          const label = entry.status === "running" ? t("timeline.thinking") : t("timeline.thoughtTurn", { turn: entry.turn });
          return (
            <details
              className={`timeline-disclosure thinking ${entry.status}`}
              key={entry.id}
              open={entry.expanded}
              onToggle={(event) => {
                if (event.currentTarget.open !== entry.expanded) onToggle(entry.id, event.currentTarget.open);
              }}
            >
              <summary>
                <span className="timeline-chevron"><ChevronRightIcon size={16} /></span>
                <span className="timeline-icon">{statusIcon(entry.status)}</span>
                <span className="timeline-label"><strong>{label}</strong><small>{entry.status === "running" ? t("timeline.modelDeciding") : t("timeline.modelReasoning")}</small></span>
                <span className={`timeline-status ${entry.status}`}>{entry.status}</span>
              </summary>
              <div className="timeline-content reasoning-content">
                {entry.content
                  ? <MarkdownRenderer content={entry.content} />
                  : <p>{entry.status === "running" ? t("timeline.waitingReasoning") : t("timeline.noReasoning")}</p>}
                {entry.truncated ? <p className="muted">This replay step was truncated by the retention policy.</p> : null}
              </div>
            </details>
          );
        }

        if (entry.trace.name === "review_checkpoint") {
          const linked = artifactReviews.some((review) => review.toolCallId === entry.trace.id);
          if (linked || entry.trace.status === "running") {
            return (
              <ReviewerPanel
                checkpointStatus={entry.trace.status}
                key={entry.id}
                reviewLevel={reviewerLevel}
                reviews={artifactReviews}
                toolCallId={entry.trace.id}
              />
            );
          }
          // Keep setup failures that happen before a Reviewer Sub-agent exists.
          if (entry.trace.status !== "failed") return null;
        }

        const outputText = entry.trace.output ?? toolOutputs[entry.trace.id] ?? entry.trace.summary;

        return (
          <details
            className={`timeline-disclosure tool ${entry.trace.status}`}
            key={entry.id}
            open={entry.expanded}
            onToggle={(event) => {
              if (event.currentTarget.open !== entry.expanded) onToggle(entry.id, event.currentTarget.open);
            }}
          >
            <summary>
              <span className="timeline-chevron"><ChevronRightIcon size={16} /></span>
              <span className="timeline-icon">{statusIcon(entry.trace.status)}</span>
              <span className="timeline-label"><strong>{entry.trace.name}</strong><small>{t("timeline.toolCall")}</small></span>
              <span className={`timeline-status ${entry.trace.status}`}>{entry.trace.status}</span>
            </summary>
            <div className="timeline-content tool-content">
              <ToolIoSections outputText={outputText} trace={entry.trace} />
            </div>
          </details>
        );
      })}
    </section>
  );
}
