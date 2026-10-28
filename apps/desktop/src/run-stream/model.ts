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

import type { PermissionRequest, SessionRunStatus, Subagent, ToolTrace } from "../api/types.js";

/** One model invoke attempt's visible text. A turn can hold several: the model
 *  may be re-invoked after a tool call, and each attempt gets its own
 *  `responseId` so an audit event landing between them cannot merge the two. */
export interface AssistantResponse {
  content: string;
  responseId?: string;
  settled: boolean;
  /** The server sent a *partial* snapshot: the text shown is not all of it. */
  truncated: boolean;
}

/**
 * One tool the model called, and where it happened in the answer.
 *
 * `after` is the index of the `responses` entry this call follows, with `-1`
 * for "before the first one". It is recorded at `tool.started` time as
 * `responses.length - 1`, which is exactly "between the model's i-th output and
 * its (i+1)-th" — the shape of an agent loop. Keeping the tools beside the
 * responses rather than merging both into one `steps` list avoids rewriting
 * every text path, which is the only reason the two are separate arrays.
 *
 * The tool's *output* is deliberately not here: it lives in a per-call
 * substream and is fetched by the card when it is opened, so the run state
 * never holds a result that only one card will ever show.
 */
export interface AssistantTool {
  after: number;
  id: string;
  trace: ToolTrace;
}

/**
 * One delegated subagent, and where it was started in the answer.
 *
 * `after` works exactly like `AssistantTool.after`: it names the response the
 * coordinator had just finished when it delegated. The whole Subagent lives
 * here, not a reference, because the transcript is the only reader and a live
 * update has to redraw the line it already sits on.
 */
export interface AssistantSubagent {
  after: number;
  subagent: Subagent;
}

/** Everything produced between two user messages. */
export interface AssistantTurn {
  turn: number;
  thinking: string;
  thinkingTruncated: boolean;
  responses: AssistantResponse[];
  tools: AssistantTool[];
  subagents: AssistantSubagent[];
}

/**
 * An authorization request the run raised, keyed by `request.id`.
 *
 * Keyed rather than appended because the same request arrives twice — once as
 * `permission.required` and again, decided, as `permission.resolved` — and a
 * reconnect can redeliver either.
 */
export interface PermissionEntry {
  request: PermissionRequest;
}

/**
 * The live half of the transcript, rebuilt from the event stream.
 *
 * It is deliberately separate from the persisted `ChatMessage[]`: only the
 * assistant's final text is stored (`ChatMessage` has no thinking field), so a
 * reload shows正文 from the session and has to replay this run's events to get
 * the thinking back. The two are merged at render time.
 */
export interface RunStreamState {
  cancelledReason?: string;
  /** Number of earlier events the server could not replay. Non-zero means the
   *  transcript below is genuinely incomplete and must say so. */
  droppedEvents: number;
  error?: { code?: string; message: string };
  /** `run.completed.message.content` — the persisted answer, which outranks
   *  anything assembled from deltas. */
  finalContent?: string;
  /**
   * When the run ended, and when it began — epoch milliseconds, taken from the
   * `SessionRun` snapshots the `run.queued` and `run.status` events carry. Their
   * difference is the "用时 …" the folded transcript line reports. Absent while
   * a run is still going, and absent for records old enough to predate the
   * fields.
   */
  finishedAt?: number;
  /** Largest replay cursor seen, for `?after=` on a reconnect. */
  lastSequence?: number;
  modelName?: string;
  /** Every authorization request this run raised, oldest first. */
  permissions: PermissionEntry[];
  runId?: string;
  startedAt?: number;
  status?: SessionRunStatus;
  /** True once a terminal `run.status` arrived, or the stream ended. */
  terminal: boolean;
  turns: AssistantTurn[];
  /** Events this version does not render, counted rather than swallowed. */
  unknownEvents: number;
}

export function emptyRunStream(): RunStreamState {
  return { droppedEvents: 0, permissions: [], terminal: false, turns: [], unknownEvents: 0 };
}

const TERMINAL_STATUSES: readonly SessionRunStatus[] = [
  "cancelled",
  "completed",
  "failed",
  "interrupted",
];

/** The server closes the `messages` response on exactly this condition, so a
 *  client that decides "done" any other way hangs on cancelled and interrupted
 *  runs. */
export function isTerminalRunStatus(status: SessionRunStatus | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.includes(status);
}

/**
 * Split the thinking stream into the step list the UI shows.
 *
 * The wire format has no step boundaries — `assistant.thinking.delta` is one
 * undivided character stream — so a blank line is the only break the model
 * ever emits deliberately. Paragraphing on it is an approximation, and a
 * single paragraph simply reads as one step.
 */
export function thinkingSteps(text: string): string[] {
  return text
    .split(/\n\s*\n/u)
    .map((step) => step.trim())
    .filter((step) => step !== "");
}

/**
 * Whether the reconstructed run has an answer body worth showing.
 *
 * This is what decides if the persisted assistant message is hidden: when the
 * stream delivered nothing (a reconnect that found no events, an aborted
 * request), hiding it would leave the turn blank. Thinking does not count — a
 * run that only thought still owes the user its persisted answer.
 */
export function hasVisibleAnswer(state: RunStreamState): boolean {
  if ((state.finalContent ?? "").trim() !== "") return true;
  return state.turns.some((turn) => turn.responses.some((response) => response.content.trim() !== ""));
}

/** The turn with this number, or a new one appended in order. */
export function turnFor(state: RunStreamState, turn: number): AssistantTurn {
  const existing = state.turns.find((candidate) => candidate.turn === turn);
  if (existing) return existing;
  return { responses: [], subagents: [], thinking: "", thinkingTruncated: false, tools: [], turn };
}

/**
 * Every subagent this run started, in the order they first appeared.
 *
 * The transcript keeps them on the turn they were delegated from, because
 * that is where the line belongs; the right panel needs one flat list to look
 * one up by id.
 */
export function allSubagents(state: RunStreamState): Subagent[] {
  return state.turns.flatMap((turn) => turn.subagents.map((entry) => entry.subagent));
}

/**
 * Apply an incoming text frame.
 *
 * `snapshot` replaces and `delta` appends. The trap is a truncated snapshot:
 * the server uses one to describe *part* of a long answer, so letting it
 * overwrite a longer buffer would make already-rendered text vanish. The
 * longer buffer wins, and the truncation is recorded instead.
 */
export function mergeText(current: string, next: string, truncated: boolean): string {
  if (truncated && next.length < current.length) return current;
  return next;
}
