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

import { useEffect, useState, type ReactNode } from "react";

import { Markdown } from "../Markdown.js";
import type { ApiClient } from "../api/client.js";
import { TEXT } from "../text.js";
import type { AssistantTurn as Turn, PermissionEntry, RunStreamState } from "../run-stream/model.js";
import { permissionMatchingKey, pendingPermissions } from "../run-stream/permission.js";
import type { PermissionDecision, PermissionRequest, SessionRunStatus } from "../api/types.js";
import { collapseHint } from "./collapse-hint.js";
import { PermissionCard } from "./PermissionCard.js";
import { ThinkingBlock } from "./ThinkingBlock.js";
import { ToolCard } from "./ToolCard.js";

/** The model's initial. Kept because the persisted transcript still has a
 *  model name to fall back on where no avatar is drawn. */
export function markOf(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "◈";
}

/** The blue round mark every assistant row wears in the handoff. One product,
 *  one mark — the model's initial made the avatar look like a person. */
export function AssistantAvatar() {
  return (
    <div aria-hidden="true" className="avatar-mini">
      <svg aria-hidden="true" fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24" width="20">
        <path d="M9.5 3.5h5M10 3.5v6.2L5.6 17a2.4 2.4 0 0 0 2.1 3.5h8.6a2.4 2.4 0 0 0 2.1-3.5L14 9.7V3.5" />
        <path d="M7.6 14.5h8.8" />
      </svg>
    </div>
  );
}

/** Copy the answer, and say the press landed. Feedback is kept in this window
 *  only: the service has no endpoint for a rating, and a button that silently
 *  wrote nowhere would be the one thing a feedback control must not be. */
function AnswerTools({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<"down" | "up">();

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="answer-tools">
      <button
        aria-label={TEXT.conversation.copyAnswer}
        className="answer-tool"
        onClick={() => {
          void navigator.clipboard?.writeText(content).then(() => setCopied(true));
        }}
        title={copied ? TEXT.conversation.copied : TEXT.conversation.copyAnswer}
        type="button"
      >
        {copied ? "✓" : (
          <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="15">
            <rect height="12" rx="2.4" width="12" x="8" y="8" />
            <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
          </svg>
        )}
      </button>
      <button
        aria-label={TEXT.conversation.feedbackHelpful}
        aria-pressed={vote === "up"}
        className="answer-tool"
        onClick={() => setVote(vote === "up" ? undefined : "up")}
        title={TEXT.conversation.feedbackHelpful}
        type="button"
      >
        <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="15">
          <path d="M7 10v10H4.5V10zM7 10l4-6.5a2 2 0 0 1 3.6 1.5L14 9h4.6a2 2 0 0 1 2 2.4l-1.3 6.6a2 2 0 0 1-2 1.6H7" />
        </svg>
      </button>
      <button
        aria-label={TEXT.conversation.feedbackUnhelpful}
        aria-pressed={vote === "down"}
        className="answer-tool"
        onClick={() => setVote(vote === "down" ? undefined : "down")}
        title={TEXT.conversation.feedbackUnhelpful}
        type="button"
      >
        <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="15">
          <path d="M17 14V4h2.5v10zM17 14l-4 6.5a2 2 0 0 1-3.6-1.5L10 15H5.4a2 2 0 0 1-2-2.4l1.3-6.6a2 2 0 0 1 2-1.6H17" />
        </svg>
      </button>
    </div>
  );
}

/**
 * One answer body.
 *
 * Shared between the two ways an answer reaches the screen — reconstructed from
 * a run's events, or read back from the session's stored messages — because
 * they are the same thing to look at, and having one element for both is what
 * keeps them from drifting apart.
 */
export function AnswerBlock({
  actions,
  content,
  live,
  truncated,
}: {
  /** The copy/feedback row belongs under a finished answer, not under the
   *  prose a folded run wrote on its way to one. */
  actions?: boolean;
  content: string;
  /** Text still arriving: a cursor follows it and the next frame will be longer. */
  live?: boolean;
  truncated?: boolean;
}) {
  return (
    <div className="text">
      <Markdown>{content}</Markdown>
      {truncated ? (
        <div className="workspace-empty">{TEXT.conversation.truncatedBody}</div>
      ) : null}
      {live ? <span className="spinner" /> : null}
      {actions === true && !live ? <AnswerTools content={content} /> : null}
    </div>
  );
}

/** What the tool cards need beyond the turn itself. Bundled because every one
 *  of them threads through unchanged. */
interface ToolContext {
  client: ApiClient;
  deciding: ReadonlySet<string>;
  interactive: boolean;
  onDecide: (request: PermissionRequest, decision: PermissionDecision) => void;
  permissions: PermissionEntry[];
  runId?: string;
  sessionId?: string;
}

/**
 * One model invoke attempt: its reasoning, then its answer.
 *
 * A run can hold several — the model is re-invoked after a tool call — and
 * each keeps its own body, because collapsing them into one would silently
 * drop everything the model said before the tool ran.
 *
 * Tool calls are woven between the answer blocks at the index they were made
 * from: `after === -1` puts a call before the first answer, `after === i` puts
 * it after the i-th. That is what makes an agent loop read in order — the model
 * says something, calls a tool, is re-invoked and says something else — instead
 * of collecting every call in a heap at the end.
 *
 * This is the *inside* of a folded run: the one response the fold hands back to
 * the transcript (`detach`) is not drawn here, because that answer is the run's
 * visible result and belongs beside it rather than one click away.
 */
function TurnBlock({
  detach,
  live,
  modelName,
  tools,
  turn,
}: {
  /** The index of the response rendered outside the fold, if this turn owns it. */
  detach?: number;
  live: boolean;
  modelName?: string;
  tools: ToolContext;
  turn: Turn;
}) {
  const layers: ReactNode[] = [];

  for (let index = -1; index < turn.responses.length; index += 1) {
    const response = index < 0 ? undefined : turn.responses[index];
    // A response that streamed no prose is skipped, but the calls recorded
    // against its slot are still emitted below.
    if (response && response.content.trim() !== "" && index !== detach) {
      layers.push(
        <div className="text" key={response.responseId ?? index}>
          <Markdown>{response.content}</Markdown>
          {response.truncated ? (
            <div className="workspace-empty">{TEXT.conversation.truncatedBody}</div>
          ) : null}
          {/* Keyed on the response, not on the turn. Testing "is this the turn's
              last response" put a cursor on all nine turns of a nine-turn run,
              because every turn has a last response of its own. `settled` is the
              server's own answer to "is this one still streaming". */}
          {live && !response.settled ? <span className="spinner" /> : null}
        </div>,
      );
    }
    // After the answer, not before it: `after` is set to `responses.length - 1`
    // when the call is announced, so it names the answer the model had just
    // finished producing when it reached for a tool.
    for (const tool of turn.tools.filter((candidate) => candidate.after === index)) {
      layers.push(
        <ToolCard
          authorized={tools.permissions.some((entry) =>
            entry.request.state === "allowed" && entry.request.toolCallId === tool.trace.id)}
          client={tools.client}
          key={`tool-${tool.id}`}
          runId={tools.runId}
          sessionId={tools.sessionId}
          trace={tool.trace}
        />,
      );
    }
  }

  return (
    <div className="run-turn">
      <div className="run-turn-head">
        {modelName ?? TEXT.appName} · {TEXT.conversation.turn(turn.turn)}
      </div>
      <ThinkingBlock live={live && turn.responses.length === 0} text={turn.thinking} truncated={turn.thinkingTruncated} />
      {layers}
    </div>
  );
}

/** The outstanding authorization requests, on their own below the run they
 *  belong to.
 *
 * Never inside the folded line: a run waiting on an answer is waiting on the
 * person reading, and a question folded shut behind a summary is a run that
 * appears to have stopped for no reason. It is drawn whether the run is over or
 * still going, which also keeps it in one place instead of two. */
function PendingCards({ context, requests }: { context: ToolContext; requests: PermissionRequest[] }) {
  if (requests.length === 0) return null;
  return (
    <>
      {requests.map((request) => (
        <PermissionCard
          busy={context.deciding.has(request.id)
            || context.deciding.has(`group:${permissionMatchingKey(request)}`)}
          interactive={context.interactive}
          key={request.id}
          onDecision={context.onDecide}
          request={request}
        />
      ))}
    </>
  );
}

/** The status band under a finished turn. It only appears when it has
 *  something to say, so a clean run leaves no residue. */
function RunStatusLine({ run }: { run: RunStreamState }) {
  const lines: string[] = [];
  if (run.droppedEvents > 0) lines.push(TEXT.conversation.droppedEvents(run.droppedEvents));
  if (run.unknownEvents > 0) lines.push(TEXT.conversation.unknownEvents(run.unknownEvents));
  if (run.error) {
    // The whole line comes from TEXT: the code's brackets and the colon are
    // punctuation of the language, not of the render.
    lines.push(
      run.error.code === undefined
        ? TEXT.conversation.errorLine(run.error.message)
        : TEXT.conversation.errorWithCode(run.error.code, run.error.message),
    );
  } else if (run.status === "cancelled") {
    lines.push(run.cancelledReason ?? TEXT.conversation.cancelled);
  } else if (run.status === "interrupted") {
    lines.push(TEXT.conversation.interrupted);
  } else if (run.terminal && run.status === undefined) {
    lines.push(TEXT.conversation.streamEnded);
  }
  if (lines.length === 0) return null;
  return (
    <div className="message assistant">
      <div aria-hidden="true" className="avatar-mini">
        !
      </div>
      <div className="body">
        {lines.map((line) => (
          <div className="status-strip" key={line}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The status words the folded line falls back on when a run has no measured
 *  span — a record written before the times existed. Read from `TEXT` when
 *  asked rather than captured, so a language switch reaches the fold too. */
function statusLabel(status: SessionRunStatus): string {
  const text = TEXT.conversation;
  switch (status) {
    case "blocked": return text.blocked;
    case "cancelled": return text.cancelled;
    case "completed": return text.completed;
    case "failed": return text.failed;
    case "interrupted": return text.interrupted;
    case "queued": return text.queued;
    case "running": return text.running;
  }
}

/** Where a run's visible answer came from, so the fold can hand exactly that
 *  one response over instead of drawing it twice. */
interface ShownAnswer {
  content: string;
  response: number;
  settled: boolean;
  truncated: boolean;
  turn: number;
}

/**
 * The answer a run leaves on screen.
 *
 * The last response that produced any prose, anywhere in the run: the model may
 * have been re-invoked a dozen times, and it is the last thing it said that the
 * user is waiting for. While the run is still going this is the sentence being
 * written right now, which is why it stays outside the fold and grows in place.
 */
function shownAnswer(run: RunStreamState): ShownAnswer | undefined {
  for (let turnIndex = run.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = run.turns[turnIndex]!;
    for (let index = turn.responses.length - 1; index >= 0; index -= 1) {
      const response = turn.responses[index]!;
      if (response.content.trim() === "") continue;
      return {
        content: response.content,
        response: index,
        settled: response.settled,
        truncated: response.truncated,
        turn: turn.turn,
      };
    }
  }
  return undefined;
}

/** Whether anything would actually be hidden by folding this run: reasoning,
 *  tool calls, or prose that is not the answer itself. A plain question and
 *  answer has none of the three and gets no fold line. */
function hasMiddleContent(run: RunStreamState, answer: ShownAnswer | undefined): boolean {
  return run.turns.some((turn) =>
    turn.thinking.trim() !== ""
    || turn.tools.length > 0
    || turn.responses.some((response, index) =>
      response.content.trim() !== ""
      && !(answer !== undefined && answer.turn === turn.turn && answer.response === index)));
}

/** The one line that stands in for everything a run did. `working` marks the
 *  lines whose icon is a turning ring rather than a still glyph: a live run
 *  that is thinking, not one that is waiting. */
function foldLabel(run: RunStreamState): { icon: string; title: string; working: boolean } {
  if (!run.terminal) {
    // Waiting and thinking are different things to the person watching: one
    // means the run is working, the other means it is waiting on them.
    const waiting = run.status === "queued" || run.status === "blocked"
      ? statusLabel(run.status)
      : undefined;
    if (waiting !== undefined) return { icon: "💭", title: waiting, working: false };
    return { icon: "💭", title: TEXT.conversation.thinkingNow, working: true };
  }
  if (run.startedAt !== undefined && run.finishedAt !== undefined) {
    return { icon: "⏱", title: TEXT.conversation.elapsed(run.finishedAt - run.startedAt), working: false };
  }
  return {
    icon: "💭",
    title: (run.status === undefined ? undefined : statusLabel(run.status))
      ?? TEXT.conversation.thinking,
    working: false,
  };
}

/**
 * The reconstructed run, rendered in place of the persisted assistant message.
 *
 * Everything the run did between the question and its answer — the reasoning,
 * the tool calls, the prose the model produced on the way — is folded into a
 * single line: "正在规划下一步" while it works, "用时 12 分 3 秒" once it is done.
 * Only the answer stays out, which is the point of the shape: a hundred-turn
 * run costs one line of transcript instead of a hundred.
 *
 * `finalContent` is the run's own completion payload. It is shown only when no
 * streamed body survives: a replayed run whose early deltas were dropped still
 * has the completion's answer, and showing both would print it twice.
 *
 * The in-flight set of decisions lives here rather than in the run state: it is
 * about this window's clicks, not about what the run did, and it must not
 * survive a re-render of the run.
 */
export function AssistantTurns({
  client,
  onDecide,
  run,
  sessionId,
}: {
  client: ApiClient;
  onDecide: (request: PermissionRequest, decision: PermissionDecision) => Promise<void>;
  run: RunStreamState;
  sessionId?: string;
}) {
  const [deciding, setDeciding] = useState<ReadonlySet<string>>(() => new Set());
  const answer = shownAnswer(run);
  const finalBody = run.finalContent?.trim() ? run.finalContent : undefined;
  // The completion payload only stands in when nothing was streamed: it is the
  // same answer, and where both survive, the streamed one is the longer.
  const showFinal = finalBody !== undefined && answer === undefined;
  const live = !run.terminal;
  // While the run is going, only the turn being written counts as its answer.
  // The model opens the next turn with its thinking, and the turn before it may
  // still be holding the sentence that introduced a tool call — printing that as
  // the result for as long as the tool runs, and then pulling it back into the
  // fold, is a transcript that changes its mind in front of the reader.
  const newest = run.turns.at(-1)?.turn;
  const shown = live && answer !== undefined && answer.turn !== newest ? undefined : answer;
  const decide = (request: PermissionRequest, decision: PermissionDecision) => {
    // An `allow_matching` answer decides every pending sibling, and it does so
    // server-side — recording the group key locks those cards in the same tick
    // rather than after their resolutions arrive.
    const keys = decision === "allow_matching"
      ? [request.id, `group:${permissionMatchingKey(request)}`]
      : [request.id];
    setDeciding((current) => new Set([...current, ...keys]));
    void onDecide(request, decision).finally(() => {
      setDeciding((current) => {
        const next = new Set(current);
        for (const key of keys) next.delete(key);
        return next;
      });
    });
  };
  const tools: ToolContext = {
    client,
    deciding,
    interactive: live,
    onDecide: decide,
    permissions: run.permissions,
    runId: run.runId,
    sessionId,
  };
  const pending = pendingPermissions(run.permissions);
  // A run still going always shows its line, even before it has thought
  // anything: that line is what says the run exists.
  const fold = live || hasMiddleContent(run, shown);
  // Nothing happened and nothing is going to: a run that failed or was
  // interrupted before producing anything is its status line, and an empty fold
  // above it would be furniture. A turn whose response streamed no prose at all
  // — the failure case — leaves the same emptiness behind a body that would
  // otherwise carry a model name and nothing else, under a second avatar.
  if (!fold && shown === undefined && !showFinal) {
    return (
      <>
        <RunStatusLine run={run} />
        <PendingCards context={tools} requests={pending} />
      </>
    );
  }
  const label = foldLabel(run);
  return (
    <>
      <div className="message assistant">
        <AssistantAvatar />
        <div className="body">
          <div className="role">
            <span>{run.modelName ?? TEXT.appName}</span>
          </div>
          {fold ? (
            <details className="msg-collapse run-fold">
              <summary>
                {/* A ring that turns while the model works; a still glyph
                    otherwise. The box is the same either way, so the line does
                    not shift when the run stops. */}
                <span className="collapse-icon">
                  {label.working
                    ? <span aria-hidden="true" className="spinner run-spinner" />
                    : label.icon}
                </span>
                <span className="collapse-title">{label.title}</span>
                <span className="collapse-meta" {...collapseHint()} />
                <span className="collapse-chev">▸</span>
              </summary>
              <div className="collapse-body">
                {run.turns.map((turn) => (
                  <TurnBlock
                    detach={shown !== undefined && shown.turn === turn.turn ? shown.response : undefined}
                    key={turn.turn}
                    live={live}
                    modelName={run.modelName}
                    tools={tools}
                    turn={turn}
                  />
                ))}
              </div>
            </details>
          ) : null}
          {shown === undefined ? null : (
            <AnswerBlock
              actions={!live}
              content={shown.content}
              live={live && !shown.settled}
              truncated={shown.truncated}
            />
          )}
          {showFinal ? <AnswerBlock actions content={finalBody} /> : null}
        </div>
      </div>
      <RunStatusLine run={run} />
      <PendingCards context={tools} requests={pending} />
    </>
  );
}
