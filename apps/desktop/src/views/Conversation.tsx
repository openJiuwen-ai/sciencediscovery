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

import { Fragment, useEffect, useRef, useState } from "react";

import type { PendingMessage } from "../app/use-workspace.js";
import type { ToolDetail } from "../app/tool-io.js";
import type { ApiClient } from "../api/client.js";
import type {
  ChatMessage,
  PermissionDecision,
  PermissionRequest,
  SessionDetail,
  WorkspaceFile,
} from "../api/types.js";
import type { RunStreamState } from "../run-stream/model.js";
import { placeReplays, type RunReplay } from "../run-stream/replay.js";
import { TEXT } from "../text.js";
import { AnswerBlock, AssistantAvatar, AssistantTurns } from "./AssistantTurn.js";
import { UploadCards } from "./UploadCards.js";
import { placeUploads, type UploadedFile } from "./uploads.js";

interface Props {
  client: ApiClient;
  detail?: SessionDetail;
  loading: boolean;
  onDecidePermission: (request: PermissionRequest, decision: PermissionDecision) => Promise<void>;
  /** Open one subagent's execution in the workspace panel. The transcript
   *  itself only ever draws its line. */
  onOpenSubagent?: (id: string) => void;
  /** Open one tool's input or result in the workspace panel. The card shows a
   *  clipped preview of both. */
  onOpenTool?: (detail: ToolDetail) => void;
  /** The session's workspace: the files whose provenance says they arrived by
   *  upload are drawn above the question they were sent with. */
  workspaceFiles: readonly WorkspaceFile[];
  pending?: PendingMessage;
  /** Every finished run of this session, each to be rendered in the place of
   *  the answer it wrote. */
  replays: readonly RunReplay[];
  /** The run streaming right now, which has no persisted answer to take. */
  run: RunStreamState;
}

/**
 * Runtime notices that ride along in the persisted transcript. They are not
 * something either side typed, so they render as a status line rather than as
 * a message bubble. The labels live in `TEXT` and are read per render, since
 * this row can survive a language switch.
 */
function NoticeRow({ message }: { message: ChatMessage }) {
  const label = message.kind ? (TEXT.conversation.notices[message.kind] ?? message.kind) : "";
  return (
    <div className="message assistant is-notice">
      <div aria-hidden="true" className="avatar-mini">
        ⌁
      </div>
      <div className="body">
        <div className="role">
          <span>{label}</span>
        </div>
        <div className="status-strip">{message.content}</div>
      </div>
    </div>
  );
}

/**
 * One of the reader's turns: the text alone, in the handoff's grey bubble
 * against the right edge. There is no avatar and no role line — the bubble's
 * side is the role, and a label saying 你 over every question was furniture.
 *
 * Files sent with the question sit above the bubble, in the same column, so
 * the two read as one turn. A turn with no files keeps the bubble as the
 * row's only child — an empty wrapper around it changes nothing on screen,
 * and this markup is what every transcript assertion in the suite reads.
 */
function UserRow({ content, files }: { content: string; files?: readonly UploadedFile[] }) {
  const bubble = (
    <div className="body">
      <div className="text">{content}</div>
    </div>
  );
  if (files === undefined || files.length === 0) {
    return <div className="message user">{bubble}</div>;
  }
  return (
    <div className="message user">
      <div className="user-turn">
        <UploadCards files={files} />
        {bubble}
      </div>
    </div>
  );
}

function MessageRow({ message, uploads }: { message: ChatMessage; uploads?: readonly UploadedFile[] }) {
  // An automatic wake carries no user-authored body — the schema keeps the
  // model-facing prompt out of `content` precisely so a wake is never shown as
  // something the user typed — so a card for it was a blank strip with an
  // avatar, saying nothing the run below it does not say better. The message
  // itself stays in the transcript either way: it is where the run the wake
  // started is anchored, and dropping it would send that run to the end of the
  // conversation instead of to the place it happened.
  if (message.kind === "wake_notice") return null;
  if (message.kind && message.kind !== "message") return <NoticeRow message={message} />;
  if (message.role === "user") return <UserRow content={message.content} files={uploads} />;
  return (
    <div className="message assistant">
      {/* The handoff puts the mark and the name on their own line, with the
          answer starting below them at the column's left edge. Keeping the
          header out of the body is what lets the two line up: content that
          started after the avatar would be indented by a column the answer
          text has no reason to lose. */}
      <div className="assistant-head">
        <AssistantAvatar />
        <div className="role">
          <span>{TEXT.appName}</span>
        </div>
      </div>
      <div className="body">
        {/* The same element a replayed run renders its answer with, so a stored
            answer and a reconstructed one cannot drift apart. */}
        <AnswerBlock actions content={message.content} />
      </div>
    </div>
  );
}

/** How long the run line waits before it is drawn for a message that has just
 *  been sent. A line that lands in the same frame as the press reads as a
 *  canned animation rather than as a receipt; a beat of silence is what asking
 *  something looks like. Only the placeholder waits — real events are drawn at
 *  once. */
const RUN_LINE_DELAY_MS = 1000;

/** True once `flag` has been true for `delayMs`, and false again as soon as it
 *  is not. The timer belongs to the flag, so a second message gets its own
 *  beat rather than inheriting the first one's. */
function useAfter(flag: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!flag) {
      setElapsed(false);
      return;
    }
    const timer = window.setTimeout(() => setElapsed(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [flag, delayMs]);
  return flag && elapsed;
}

/**
 * The transcript.
 *
 * Two sources have to be merged, and the merge is the whole trick here:
 * `SessionDetail.messages` is what the server persisted — the user's turns and
 * the assistant's final answers, with no thinking at all — while the events of
 * each run are what reconstructs how those answers were arrived at. So every
 * finished run is rendered **in the place of the answer it wrote**, which is
 * what brings its thinking and its tool calls back after a reload without
 * printing the answer twice. A session that took several turns has one replay
 * per turn, and the run still streaming has none yet, so it goes at the end.
 */
export function Conversation({
  client,
  detail,
  loading,
  onDecidePermission,
  onOpenSubagent,
  onOpenTool,
  pending,
  replays,
  run,
  workspaceFiles,
}: Props) {
  const scroller = useRef<HTMLElement>(null);
  const stick = useRef(true);
  /** How tall the transcript was at the last pin. Growth after it is the
   *  transcript getting longer, not the reader leaving the bottom — the scroll
   *  event an appended answer fires would otherwise read as a scroll-away and
   *  stop the transcript following the run, leaving the run's own line under
   *  the composer, out of sight. */
  const pinned = useRef({ height: 0 });

  const messages = detail?.messages ?? [];
  const { following, replacing, trailing } = placeReplays(replays, messages);
  /** The files each question was sent with, and the ones still waiting for a
   *  question. Uploads are workspace files rather than message fields, so they
   *  are matched to turns by time — see `placeUploads`. */
  const uploads = placeUploads(workspaceFiles, messages);
  const reconstructed = run.turns.length > 0 || run.finalContent !== undefined;
  /** A message just sent has no run events yet — the request is still in
   *  flight — but the run exists from the press, and its line is what says so.
   *  Waiting for the first event would leave the user's message alone in the
   *  transcript for as long as the round trip takes; drawing the placeholder in
   *  the same frame as the press would claim the run started before the server
   *  has said anything. So the placeholder is drawn a beat late, and anything
   *  the stream has actually produced is drawn at once. */
  const placeholder = useAfter(pending !== undefined, RUN_LINE_DELAY_MS);
  const liveRun = reconstructed || placeholder;

  // `liveRun` pins too: the run line is drawn a beat after the press, and a
  // pin that skipped it would leave the one line saying the run exists below
  // the composer for as long as the model takes to say anything.
  useEffect(() => {
    const node = scroller.current;
    if (!node || !stick.current) return;
    node.scrollTop = node.scrollHeight;
    pinned.current = { height: node.scrollHeight };
  }, [liveRun, messages, pending, replays, run]);

  const onScroll = () => {
    const node = scroller.current;
    if (!node) return;
    // Follow only while the user is already at the bottom: pulling someone
    // back down while they read an earlier turn is worse than not following.
    // What counts is the distance the reader put there themselves, so the
    // text appended since the last pin is discounted.
    const grown = Math.max(0, node.scrollHeight - pinned.current.height);
    stick.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 80 + grown;
  };

  return (
    <section className="conversation" onScroll={onScroll} ref={scroller}>
      <div className="messages">
        {messages.map((message) => {
          const replacement = replacing.get(message.id);
          return (
            <Fragment key={message.id}>
              {replacement === undefined ? (
                <MessageRow message={message} uploads={uploads.byMessage.get(message.id)} />
              ) : (
                <AssistantTurns
                  client={client}
                  onDecide={onDecidePermission}
                  onOpenSubagent={onOpenSubagent}
                  onOpenTool={onOpenTool}
                  run={replacement}
                  sessionId={detail?.id}
                />
              )}
              {/* A run that never wrote an answer still belongs here, after
                  the message that started it, rather than at the end of a
                  conversation it did not come last in. */}
              {(following.get(message.id) ?? []).map((replay) => (
                <AssistantTurns
                  client={client}
                  key={replay.runId}
                  onDecide={onDecidePermission}
                  onOpenSubagent={onOpenSubagent}
                  onOpenTool={onOpenTool}
                  run={replay.state}
                  sessionId={detail?.id}
                />
              ))}
            </Fragment>
          );
        })}
        {trailing.map((replay) => (
          <AssistantTurns
            client={client}
            key={replay.runId}
            onDecide={onDecidePermission}
            onOpenSubagent={onOpenSubagent}
            onOpenTool={onOpenTool}
            run={replay.state}
            sessionId={detail?.id}
          />
        ))}
        {pending ? <UserRow content={pending.content} files={uploads.trailing} /> : null}
        {/* No persisted answer to stand in for yet — the run is still going,
            or the session was created by sending into it. A replayed run is
            never here: it is in `replays`, anchored to its own answer. */}
        {liveRun ? (
          <AssistantTurns
            client={client}
            onDecide={onDecidePermission}
            onOpenSubagent={onOpenSubagent}
            onOpenTool={onOpenTool}
            run={run}
            sessionId={detail?.id}
          />
        ) : null}
        {loading ? <div className="status-strip">{TEXT.boot.checking}</div> : null}
      </div>
    </section>
  );
}
