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

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ConfigurationRequestCard, genericConfigurationPresentation, type ConfigurationProcessRecordProps } from "@sciencediscovery/configuration-ui";
import type { ConfigurationRequestView, ConnectorConfigurationRequest } from "@sciencediscovery/schema";
import type { useConfigurationRequests } from "../app/use-configuration-requests.js";
import { useLanguage } from "../app/use-language.js";
import { configurationRequestActions, decideLegacyConnectorConfiguration, type DesktopConfigurationRequest } from "../api/configuration.js";
import { legacyConfigurationPresentation } from "../app/legacy-configuration.js";
import { LegacyConnectorConfigurationCard } from "./LegacyConnectorConfigurationCard.js";
import { cancelRun } from "../api/sessions.js";
import { ApiRequestError } from "../api/client.js";

import type { PendingMessage } from "../app/use-workspace.js";
import type { ToolDetail } from "../app/tool-io.js";
import type { ApiClient } from "../api/client.js";
import type {
  ArtifactReviewRun,
  ChatMessage,
  ComposerReference,
  PermissionDecision,
  PermissionRequest,
  RuntimeNotice,
  SessionArtifactOutput,
  SessionDetail,
  WorkspaceFile,
} from "../api/types.js";
import type { RunStreamState } from "../run-stream/model.js";
import { hasReplayContent, placeReplays, type RunReplay } from "../run-stream/replay.js";
import { allSubagents } from "../run-stream/model.js";
import { TEXT } from "../text.js";
import { coalesceTimeoutNotices } from "../run-failure.js";
import { RunFailureCard } from "./RunFailureCard.js";
import { AnswerBlock, AssistantAvatar, AssistantTurns } from "./AssistantTurn.js";
import { UploadCards } from "./UploadCards.js";
import { useTurnUsage } from "../app/use-turn-usage.js";
import { TurnUsage } from "./TurnUsage.js";
import { placeUploads, type UploadedFile } from "./uploads.js";
import { turnArtifactsByRun, turnLineage, type TurnArtifact } from "../app/turn-artifacts.js";
import { ReviewCard } from "./reviewer/ReviewCard.js";

import { desktopConfigurationPresentation } from "../app/configuration-presentation.js";
import type { SettingsGroup } from "./SystemSettingsDialog.js";

interface Props {
  onOpenConfigurationSettings?: (group: SettingsGroup) => void;
  onBranch?: (messageId: string) => void;
  onConfigurationChange?: (request: DesktopConfigurationRequest) => void;
  configurationReadOnly?: boolean;
  configuration?: ReturnType<typeof useConfigurationRequests>;
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
  /** Open the right panel's artifact group from a turn strip's overflow card. */
  onOpenArtifactPanel?: () => void;
  /** Show one of a turn's artifacts in the right panel, at the version its card
   *  names. The strip is a door into the panel, not the dialog. */
  onPreviewArtifact?: (row: TurnArtifact) => void;
  /** Every artifact version this Session holds; each turn's strip is selected
   *  from it by run id (#1252). The right panel reads the same list. */
  outputs?: readonly SessionArtifactOutput[];
  /** Opens the memory card behind a `[alias]` chip in an answer. The report
   *  preview and the conversation point at the same card. */
  onReferenceClick?: (reference: ComposerReference, sessionId?: string) => void;
  /** The session's workspace: the files whose provenance says they arrived by
   *  upload are drawn above the question they were sent with. */
  workspaceFiles: readonly WorkspaceFile[];
  pending?: PendingMessage;
  /** Every review of this session's report-shaped versions. The card at a
   *  checkpoint reads its own share of this list by `toolCallId`. */
  reviews?: readonly ArtifactReviewRun[];
  /** Tool calls whose review is queued or running right now. A checkpoint
   *  with no reviews yet draws its running line only for one of these. */
  reviewerActive?: ReadonlySet<string>;
  /** Ask for the checkpoint behind a message to be reviewed again. */
  onReview?: (messageId: string) => void;
  /** Every finished run of this session, each to be rendered in the place of
   *  the answer it wrote. */
  replays: readonly RunReplay[];
  /** The run streaming right now, which has no persisted answer to take. */
  run: RunStreamState;
  /** The session's Idea Tree researches, drawn after the last turn rather than
   *  pinned above the transcript. The three surfaces keep the order the
   *  session lists them in: the research cards, the legacy graph's card, and
   *  the notice that the list could not be read. */
  ideaCards?: ReactNode;
  ideaLegacy?: ReactNode;
  ideaNotice?: ReactNode;
  /** What the conversation produced that outlives it: the session's searches,
   *  drawn after the last turn and after the Idea Tree surfaces. */
  evolve?: ReactNode;
}

const NO_OUTPUTS: readonly SessionArtifactOutput[] = [];

const EMPTY_CONFIGURATION: ReturnType<typeof useConfigurationRequests> = {
  requests: [], legacyRequests: [], loading: false, error: false,
  refresh: async () => {}, update: () => {}, remove: () => {},
};

/**
 * Notices the desktop transcript does not draw.
 *
 * `review_notice` is the Reviewer Specialist's internal record — the read-only
 * feedback the lead Agent gets on its next turn. Its content is written for a
 * model, so the transcript does not print it. A `reviewer_checkpoint` is drawn
 * too, but by `ReviewCard`, which is why it never reaches the notice row.
 */
const HIDDEN_NOTICE_KINDS: ReadonlySet<string> = new Set(["review_notice", "reviewer_checkpoint"]);

/**
 * Runtime notices that ride along in the persisted transcript. They are not
 * something either side typed, so they render as a status line rather than as
 * a message bubble. The labels live in `TEXT` and are read per render, since
 * this row can survive a language switch.
 */
function NoticeRow({ message }: { message: ChatMessage }) {
  const label = message.kind ? (TEXT.conversation.notices[message.kind] ?? message.kind) : "";
  if (message.kind === "timeout_notice") {
    return <RunFailureCard code="timeout" scope="notice" message={message.content} timeout={message.timeout} />;
  }
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

/** The one wake the transcript must explain: a run the server started after an
 *  interruption cut the previous turn short before it reported anything. Every
 *  other wake has nothing to add to the run below it, but this one is the only
 *  reason a second run exists at all, and the interrupted run stays marked as
 *  interrupted. */
function InterruptionNotice({ notice, runId }: { notice: RuntimeNotice; runId: string }) {
  return (
    <div className="message assistant is-notice">
      <div aria-hidden="true" className="avatar-mini">
        ⌁
      </div>
      <div className="body">
        <div className="role">
          <span>{TEXT.conversation.notices.wake_notice}</span>
        </div>
        <div className="status-strip">{TEXT.conversation.interruptedResume(notice.wakeAttempt ?? 2)}</div>
        <div className="status-strip">{TEXT.conversation.interruptedRun(runId)}</div>
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

function MessageRow({
  usage,
  answered,
  message,
  onBranch,
  onReferenceClick,
  uploads,
}: {
  usage?: ReactNode;
  answered?: boolean;
  message: ChatMessage;
  onBranch?: () => void;
  onReferenceClick?: (reference: ComposerReference) => void;
  uploads?: readonly UploadedFile[];
}) {
  // An automatic wake carries no user-authored body — the schema keeps the
  // model-facing prompt out of `content` precisely so a wake is never shown as
  // something the user typed — so a generic wake's card was a blank strip,
  // saying nothing the run below it does not say better. The one exception is
  // a wake the server started after an interruption: that card explains why a
  // second run exists, so it is drawn here. Either way the message stays in the
  // transcript: it is where the run the wake started is anchored, and dropping
  // it would send that run to the end of the conversation instead of to the
  // place it happened.
  if (message.kind === "wake_notice") {
    return message.runtimeNotice?.wakeAfterRunId
      ? <InterruptionNotice notice={message.runtimeNotice} runId={message.runtimeNotice.wakeAfterRunId} />
      : null;
  }
  // The review record is the Reviewer Specialist's own audit trail. A
  // checkpoint never reaches here — the transcript draws `ReviewCard` for it
  // above — so the second kind in the set is a guard for any other entry point.
  if (message.kind !== undefined && HIDDEN_NOTICE_KINDS.has(message.kind)) return null;
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
        <AnswerBlock
          actions
          answered={answered}
          content={message.content}
          usage={usage}
          onBranch={onBranch}
          onReferenceClick={onReferenceClick}
          references={message.references}
        />
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

/** The tool-call prefix the window mints for a review the reader started. It
 *  is not a run's tool call, so the running turn does not hold its card back. */
const MANUAL_REVIEW_PREFIX = "manual-review:";

/** One persisted message and the position it held in stored order — what
 *  `answeredAfter` is keyed by, so it survives being drawn somewhere else. */
interface PlacedMessage {
  index: number;
  message: ChatMessage;
}

/**
 * Put each review checkpoint at the end of the turn whose artifacts it read.
 *
 * A checkpoint message is written when the review starts, mid-turn, and the
 * run's answer is only written when the run ends — so stored order would draw
 * the card above the thinking and tool calls it reviews, directly under the
 * question it is not answering. The card is the verdict on what the turn
 * produced, so it belongs after that turn's answer. A turn is the messages
 * between two of the reader's own: checkpoints are held back to the boundary
 * before the next question, keep their own order, and a checkpoint that
 * precedes the first question stays at the head of the transcript.
 */
function placeCheckpoints(messages: readonly ChatMessage[]): PlacedMessage[] {
  const placed: PlacedMessage[] = [];
  const held: PlacedMessage[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "user" && held.length > 0) {
      placed.push(...held);
      held.length = 0;
    }
    if (message.kind === "reviewer_checkpoint") held.push({ index, message });
    else placed.push({ index, message });
  }
  placed.push(...held);
  return placed;
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
 *
 * Review checkpoint messages are written mid-turn, before the answer they
 * belong after; `placeCheckpoints` is what draws them at the turn's end.
 */
export function Conversation({
  onOpenConfigurationSettings,
  onBranch,
  onConfigurationChange,
  configurationReadOnly = false,
  configuration = EMPTY_CONFIGURATION,
  client,
  detail,
  loading,
  onDecidePermission,
  onOpenSubagent,
  onOpenTool,
  onOpenArtifactPanel,
  onPreviewArtifact,
  onReferenceClick,
  outputs,
  pending,
  reviews = [],
  reviewerActive,
  onReview,
  replays,
  run,
  ideaCards,
  ideaLegacy,
  ideaNotice,
  evolve,
  workspaceFiles,
}: Props) {
  const language = useLanguage();
  const usageRevision = `${run.runId ?? ""}:${run.terminal}:${detail?.messages.length ?? 0}:${replays.map(item => `${item.runId}:${item.state.terminal}`).join(",")}`;
  const usage = useTurnUsage(client, detail?.id, usageRevision);
  const usageNodes = useMemo(() => {
    const nodes = new Map<string, ReactNode>();
    for (const [id, data] of usage.index.byRun) nodes.set(`run:${id}`, <TurnUsage data={data}
      loading={usage.loading} failed={usage.failed} onRefresh={usage.refresh} />);
    for (const [id, data] of usage.index.byMessage) nodes.set(`message:${id}`, <TurnUsage data={data}
      loading={usage.loading} failed={usage.failed} onRefresh={usage.refresh} />);
    return nodes;
  }, [usage.index, usage.loading, usage.failed, usage.refresh]);
  const usageFallback = useMemo(() => usage.loading || usage.failed
    ? <TurnUsage loading={usage.loading} failed={usage.failed} onRefresh={usage.refresh} /> : undefined,
    [usage.loading, usage.failed, usage.refresh]);
  const usageFor = (runId?: string, messageId?: string) => usageNodes.get(runId ? `run:${runId}` : `message:${messageId}`) ?? usageFallback;
  const presentation = genericConfigurationPresentation(configuration.requests, detail?.messages ?? [], new Map(), detail?.id);
  const legacyPresentation = legacyConfigurationPresentation(configuration.legacyRequests, detail?.messages ?? [], replays, detail?.id);
  function renderLegacyConfiguration(request: ConnectorConfigurationRequest) {
    return <div className="desktop-configuration" key={request.id}>
      <LegacyConnectorConfigurationCard
        key={`${request.sessionId}:${request.id}`}
        request={request}
        ProcessRecord={ConfigurationRecord}
        readOnly={configurationReadOnly || configuration.error}
        runActive={Boolean(run.runId) && !run.terminal
          && !(run.runId === request.runId && run.status === "blocked")}
        onRefresh={configuration.refresh}
        onDecision={async decision => {
          configuration.update(await decideLegacyConnectorConfiguration(client, request, decision));
          await configuration.refresh();
        }}
      />
    </div>;
  }
  function renderConfiguration(request: ConfigurationRequestView) {
    const presentation = desktopConfigurationPresentation(request);
    return <div className="desktop-configuration" key={request.id}>
      <ConfigurationRequestCard
        key={`${request.sessionId}:${request.id}`}
        request={request}
        compact={{ connectorRestoration: presentation.connectorRestoration, connectorAddition: presentation.connectorAddition, destructive: presentation.destructive, fieldIds: presentation.fieldIds, targetLabel: presentation.targetLabel,
          unsupported: presentation.unsupported || Boolean(presentation.settingsGroup && !onOpenConfigurationSettings),
          settingsDestination: presentation.settingsGroup as "models" | "timeouts" | "mcp" | "proxy" | undefined,
          onOpenSettings: presentation.settingsGroup && onOpenConfigurationSettings
            ? () => onOpenConfigurationSettings(presentation.settingsGroup!) : undefined }}
        locale={language}
        ProcessRecord={ConfigurationRecord}
        ApiRequestError={ApiRequestError}
        actions={configurationRequestActions(client, request)}
        readOnly={configurationReadOnly || configuration.error}
        runActive={Boolean(request.runId) && run.runId === request.runId && !run.terminal && run.status !== "blocked"}
        onUpdate={configuration.update}
        onUnavailable={() => configuration.remove(request.id)}
        onStopTask={request.runId ? async () => {
          await cancelRun(client, request.sessionId, request.runId!);
          await configuration.refresh();
          onConfigurationChange?.(request);
        } : undefined}
      />
    </div>;
  }
  const scroller = useRef<HTMLElement>(null);
  /** The transcript itself, watched for growth after the pin. */
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** How tall the transcript was at the last pin. Growth after it is the
   *  transcript getting longer, not the reader leaving the bottom — the scroll
   *  event an appended answer fires would otherwise read as a scroll-away and
   *  stop the transcript following the run, leaving the run's own line under
   *  the composer, out of sight. */
  const pinned = useRef({ height: 0 });

  const messages = detail?.messages ?? [];
  const failures = coalesceTimeoutNotices(messages, replays, run);
  /** A review records the tool call that asked for it, and the checkpoint
   *  message carries the same id. That join is what puts each review under the
   *  turn that produced its artifacts instead of at the end of the session. */
  const reviewsByToolCall = useMemo(() => {
    const byToolCall = new Map<string, ArtifactReviewRun[]>();
    for (const review of reviews) {
      if (review.toolCallId === undefined) continue;
      const list = byToolCall.get(review.toolCallId) ?? [];
      list.push(review);
      byToolCall.set(review.toolCallId, list);
    }
    return byToolCall;
  }, [reviews]);
  const { following, replacing, trailing } = placeReplays(failures.replays, messages);
  /** The transcript in the order it is drawn: checkpoints at their turn's end,
   *  the persisted order otherwise. */
  const placed = useMemo(() => placeCheckpoints(messages), [messages]);
  const visibleRun = failures.run;
  /** A chip opens the card for this session; the transcript is the session's
   *  own, so the id is not a per-row value. Stable so the memoised turns under
   *  it are not re-rendered — and their Markdown re-parsed — by a press that
   *  merely opens the dialog. */
  /** Which Run a version belongs to: the transcript's own runs, and the children
   *  whose versions name them instead. A version with neither is left out rather
   *  than guessed at by timestamp. */
  const lineage = useMemo(
    () => turnLineage(
      [
        ...(run.runId === undefined ? [] : [run.runId]),
        ...replays.map((replay) => replay.runId),
      ],
      [...allSubagents(run), ...replays.flatMap((replay) => allSubagents(replay.state))],
    ),
    [run, replays],
  );
  /** One selection per run, made once per `outputs`/`lineage` pair: the
   *  conversation draws a strip under every turn, and walking the whole output
   *  list in each of them would make typing in the composer cost
   *  O(turns × outputs). */
  const artifactsByRun = useMemo(
    () => turnArtifactsByRun(outputs ?? NO_OUTPUTS, lineage),
    [lineage, outputs],
  );
  const referenceClick = useMemo(
    () => onReferenceClick === undefined
      ? undefined
      : (reference: ComposerReference) => onReferenceClick(reference, detail?.id),
    [onReferenceClick, detail?.id],
  );
  /** The files each question was sent with, and the ones still waiting for a
   *  question. Uploads are workspace files rather than message fields, so they
   *  are matched to turns by time — see `placeUploads`. */
  const uploads = placeUploads(workspaceFiles, messages);
  /** Whether a user turn comes after each message — the one fact a checkpoint
   *  card cannot read for itself. A later answer means the card's question has
   *  been met, so the card folds to its header. A just-sent message counts as
   *  one already (`pending`), so pressing 确认 folds the card in the same frame
   *  rather than when the server persists the reply. */
  const answeredAfter = useMemo(() => {
    const flags = messages.map(() => false);
    let later = pending !== undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      flags[index] = later;
      if (messages[index]!.role === "user") later = true;
    }
    return flags;
  }, [messages, pending]);
  const reconstructed = hasReplayContent(visibleRun);
  /** A message just sent has no run events yet — the request is still in
   *  flight — but the run exists from the press, and its line is what says so.
   *  Waiting for the first event would leave the user's message alone in the
   *  transcript for as long as the round trip takes; drawing the placeholder in
   *  the same frame as the press would claim the run started before the server
   *  has said anything. So the placeholder is drawn a beat late, and anything
   *  the stream has actually produced is drawn at once. */
  const placeholder = useAfter(pending !== undefined, RUN_LINE_DELAY_MS);
  const liveRun = (reconstructed || placeholder) && !replays.some(replay => replay.runId === visibleRun.runId);
  /** When the turn now streaming began. A review card stamped after it belongs
   *  to that unfinished turn and waits for its answer; without a start time the
   *  card is drawn as stored rather than guessed at. */
  const liveSince = liveRun ? visibleRun.startedAt : undefined;

  // `liveRun` pins too: the run line is drawn a beat after the press, and a
  // pin that skipped it would leave the one line saying the run exists below
  // the composer for as long as the model takes to say anything.
  useEffect(() => {
    const node = scroller.current;
    if (!node || !stick.current) return;
    node.scrollTop = node.scrollHeight;
    pinned.current = { height: node.scrollHeight };
  }, [liveRun, messages, pending, replays, run]);

  // Content that arrives after the pin makes the transcript taller below the
  // reader instead of moving it, and nothing above re-pins for it: the search
  // cards are fetched a beat after the messages they sit under, so a session
  // opened with runs left its card half hidden under the composer. A reader at
  // the bottom wants the newest thing in view however it arrived, so follow
  // growth the same way an appended answer is followed — and leave someone
  // reading further up alone.
  useEffect(() => {
    const node = scroller.current;
    const inner = content.current;
    if (node === null || inner === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!stick.current) return;
      node.scrollTop = node.scrollHeight;
      pinned.current = { height: node.scrollHeight };
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

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
      <div className="messages" ref={content}>
        {placed.map(({ index, message }) => {
          if (failures.hiddenNoticeIds.has(message.id) || presentation.suppressedNoticeIds.has(message.id)
            || legacyPresentation.suppressedNoticeIds.has(message.id)) return null;
          // The card is drawn at the end of its turn, after the answer it is a
          // verdict on; `placeCheckpoints` is what puts it there.
          if (message.kind === "reviewer_checkpoint") {
            const checkpoint = message.reviewerCheckpoint;
            if (checkpoint === undefined) return null;
            // A card written while this turn is still being written is a
            // message between the agents, not a verdict for the reader: drawing
            // it now would put it above the reply it is a verdict on. It waits
            // for the turn to end. A card the coordinator wrote after an
            // earlier turn is drawn at once, and so is one the reader started
            // themselves — only what the run wrote is held.
            if (liveSince !== undefined && !checkpoint.toolCallId.startsWith(MANUAL_REVIEW_PREFIX)
              && Date.parse(message.createdAt) >= liveSince) return null;
            return (
              <ReviewCard
                checkpoint={checkpoint}
                key={message.id}
                messageId={message.id}
                onReview={onReview}
                reviews={reviewsByToolCall.get(checkpoint.toolCallId) ?? []}
                running={reviewerActive?.has(checkpoint.toolCallId) ?? false}
              />
            );
          }
          const configurationAtNotice = presentation.byNoticeId.get(message.id);
          const legacyAtNotice = legacyPresentation.byNoticeId.get(message.id);
          // The API's empty request anchor is represented by the pending card
          // below. Keep meaningful continuation messages and unknown notices.
          if (!configurationAtNotice && message.kind === "configuration_notice" && !message.content.trim()
            && configuration.requests.some(request => request.sessionId === detail?.id && request.id === message.configurationRequestId)) return null;
          const replacement = replacing.get(message.id);
          return (
            <Fragment key={message.id}>
              {configurationAtNotice ? renderConfiguration(configurationAtNotice) : legacyAtNotice ? renderLegacyConfiguration(legacyAtNotice) : replacement === undefined ? (
                <MessageRow
                  usage={usageFor(undefined, message.id)}
                  answered={answeredAfter[index]}
                  message={message}
                  onBranch={onBranch && message.role === "assistant" ? () => onBranch(message.id) : undefined}
                  onReferenceClick={referenceClick}
                  uploads={uploads.byMessage.get(message.id)}
                />
              ) : (
                <AssistantTurns
                  usage={usageFor(replacement.runId)}
                  answered={answeredAfter[index]}
                  artifacts={artifactsByRun.get(replacement.runId ?? "")}
                  client={client}
                  onDecide={onDecidePermission}
                  onOpenArtifactPanel={onOpenArtifactPanel}
                  onPreviewArtifact={onPreviewArtifact}
                  onOpenSubagent={onOpenSubagent}
                  onOpenTool={onOpenTool}
                  onReferenceClick={referenceClick}
                  // The answer being replaced is the message whose chips the
                  // replay is drawing: its references are what make the
                  // `[alias]` tokens in the reconstructed text links.
                  references={message.references}
                  run={replacement}
                  onBranch={onBranch ? () => onBranch(message.id) : undefined}
                  sessionId={detail?.id}
                />
              )}
              {/* A run that never wrote an answer still belongs here, after
                  the message that started it, rather than at the end of a
                  conversation it did not come last in. */}
              {(following.get(message.id) ?? []).map((replay) => (
                <AssistantTurns
                  usage={usageFor(replay.runId)}
                  answered={answeredAfter[index]}
                  artifacts={artifactsByRun.get(replay.runId)}
                  client={client}
                  key={replay.runId}
                  onDecide={onDecidePermission}
                  onOpenArtifactPanel={onOpenArtifactPanel}
                  onPreviewArtifact={onPreviewArtifact}
                  onOpenSubagent={onOpenSubagent}
                  onOpenTool={onOpenTool}
                  onReferenceClick={referenceClick}
                  run={replay.state}
                  sessionId={detail?.id}
                />
              ))}
            </Fragment>
          );
        })}
        {trailing.map((replay) => (
          <AssistantTurns
            usage={usageFor(replay.runId)}
            answered={pending !== undefined}
            artifacts={artifactsByRun.get(replay.runId)}
            client={client}
            key={replay.runId}
            onDecide={onDecidePermission}
            onOpenArtifactPanel={onOpenArtifactPanel}
            onPreviewArtifact={onPreviewArtifact}
            onOpenSubagent={onOpenSubagent}
            onOpenTool={onOpenTool}
            onReferenceClick={referenceClick}
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
            usage={usageFor(visibleRun.runId)}
            artifacts={artifactsByRun.get(visibleRun.runId ?? "")}
            client={client}
            onDecide={onDecidePermission}
            onOpenArtifactPanel={onOpenArtifactPanel}
            onPreviewArtifact={onPreviewArtifact}
            onOpenSubagent={onOpenSubagent}
            onOpenTool={onOpenTool}
            onReferenceClick={referenceClick}
            run={visibleRun}
            sessionId={detail?.id}
          />
        ) : null}
        {presentation.visibleRequests.map(renderConfiguration)}
        {legacyPresentation.visibleRequests.map(renderLegacyConfiguration)}
        {configuration.loading && !configuration.requests.length && !configuration.legacyRequests.length ? <div className="status-strip">{TEXT.boot.checking}</div> : null}
        {configuration.error ? <div className="desktop-configuration configuration-load-error" role="alert">
          <span>{TEXT.conversation.configurationRefreshFailed}</span>
          <button type="button" onClick={() => void configuration.refresh()}>{TEXT.conversation.retryConfiguration}</button>
        </div> : null}
        {ideaCards != null || ideaLegacy != null || ideaNotice != null ? (
          <div className="idea-tree-slot">
            {ideaCards}
            {ideaLegacy}
            {ideaNotice}
          </div>
        ) : null}
        {evolve}
        {loading ? <div className="status-strip">{TEXT.boot.checking}</div> : null}
      </div>
    </section>
  );
}

/** Terminal receipts use the new transcript's compact disclosure, while pending
 * decisions retain their complete destination, impact and action controls. */
export function ConfigurationRecord({ children, label, failed, className = "" }: ConfigurationProcessRecordProps) {
  return <details className={`msg-collapse tool-card desktop-configuration-record ${className}${failed ? " failed" : ""}`}>
    <summary>
      <span className="collapse-title">{label}</span>
      {failed ? <span className="configuration-failed">!</span> : null}
      <span aria-hidden="true" className="collapse-chev">›</span>
    </summary>
    <div className="configuration-record-body">{children}</div>
  </details>;
}
