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

import type { RunStreamEvent, ToolTrace } from "../api/types.js";
import { TEXT } from "../text.js";
import {
  type AssistantResponse,
  type AssistantTurn,
  type RunStreamState,
  isTerminalRunStatus,
  mergeText,
  turnFor,
} from "./model.js";
import { mergePermission } from "./permission.js";
import { applySubagentEvent, type SubagentEvent } from "./subagent.js";

/**
 * Event types this version knows about and deliberately does not render yet.
 *
 * They stay out of the unknown-event counter so that "N events this build
 * cannot draw" means an actual surprise rather than a phase-two backlog.
 * Everything here is an artifact, plan or orchestration surface with no
 * placeholder in the current design.
 *
 * `artifact.upserted` and `workspace.changed` are the exception in one
 * respect: the transcript draws nothing for them, but the right panel re-reads
 * its artifact list and workspace tree when they arrive — see
 * `app/panel-refresh.ts`.
 */
const DEFERRED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent.phase",
  "agent.record",
  "artifact.upserted",
  "artifact_review.completed",
  "evolve_run.created",
  "idea_research.created",
  "idea_tree.phase",
  "plan.updated",
  "remote_job.proposed",
  "reviewer_checkpoint.updated",
  "session.approval_mode.changed",
  "session.updated", // the sidebar owns the title, not the transcript
  "workspace.changed",
]);

/**
 * Events the run state has no place for, but which are not surprises either.
 *
 * `tool.output` is the one member: a tool's result is persisted to its own
 * substream (`tool-<toolCallId>`) and the card reads it from there on demand,
 * so nothing in this reducer needs it. Two details make it worth a set of its
 * own rather than a place in `DEFERRED_EVENT_TYPES`:
 *
 *  - It is *also* fanned out live over the run's own event stream, where it
 *    carries no `id:` line (the frame decoder tolerates that and reports no
 *    sequence for it) and `sequence: 0` in the JSON route's sibling records.
 *    Counting it as unknown would make a perfectly normal run report "N events
 *    this build cannot draw".
 *  - It must not advance the replay cursor either: it is a copy of something
 *    already on the substream, and reading it back through `?after=` would only
 *    make the reconnect ask for the same bytes twice.
 */
const STREAMED_ELSEWHERE: ReadonlySet<string> = new Set(["tool.output"]);

/**
 * Fold one stream event into the live transcript.
 *
 * Pure and incremental on purpose: the same function rebuilds a finished run
 * from `?after=0`, folds a live `POST /messages` response and extends a
 * reconnect, so there is exactly one interpretation of the stream.
 */
export function reduceRunStream(
  state: RunStreamState,
  event: RunStreamEvent,
  sequence?: number,
): RunStreamState {
  const advanced = sequence === undefined
    ? state
    : { ...state, lastSequence: Math.max(state.lastSequence ?? 0, sequence) };

  switch (event.type) {
    case "run.queued":
      // The earliest place a run id is visible at all: the POST that starts
      // the run does not return one.
      return { ...advanced, runId: event.run.id, ...runTimes(advanced, event.run), status: event.run.status };

    case "run.started":
      return { ...advanced, modelName: event.model.name, runId: event.runId, status: "running" };

    case "assistant.response.started":
      return withTurn(advanced, event.turn, (turn) =>
        turn.responses.some((response) => response.responseId === event.responseId)
          ? turn
          : { ...turn, responses: [...turn.responses, blankResponse(event.responseId)] });

    case "assistant.delta":
      return withResponse(advanced, event.responseId, (response) => ({
        ...response,
        content: response.content + event.delta,
      }));

    case "assistant.snapshot": {
      const truncated = event.truncated === true;
      return withResponse(advanced, event.responseId, (response) => ({
        ...response,
        content: mergeText(response.content, event.content, truncated),
        truncated: response.truncated || truncated,
      }));
    }

    case "assistant.thinking.delta":
      return withTurn(advanced, event.turn, (turn) => ({
        ...turn,
        thinking: turn.thinking + event.delta,
      }));

    case "assistant.thinking.snapshot": {
      const truncated = event.truncated === true;
      return withTurn(advanced, event.turn, (turn) => ({
        ...turn,
        thinking: mergeText(turn.thinking, event.content, truncated),
        thinkingTruncated: turn.thinkingTruncated || truncated,
      }));
    }

    case "assistant.response.settled":
      return withResponse(advanced, event.responseId, (response) => ({ ...response, settled: true }));

    case "tool.started":
      // Neither tool event carries a turn number, so the call belongs to the
      // newest turn — the one the model is currently working in.
      return withTurn(advanced, newestTurn(advanced), (turn) => {
        const index = turn.tools.findIndex((tool) => tool.id === event.trace.id);
        // A repeated start is a restart of the same call: keep where it sits
        // and take the fresh trace.
        if (index >= 0) {
          return {
            ...turn,
            tools: turn.tools.map((tool, position) =>
              position === index ? { ...tool, trace: event.trace } : tool),
          };
        }
        return {
          ...turn,
          tools: [...turn.tools, { after: turn.responses.length - 1, id: event.trace.id, trace: event.trace }],
        };
      });

    case "tool.completed":
      return withTurn(advanced, newestTurn(advanced), (turn) => {
        const index = turn.tools.findIndex((tool) => tool.id === event.trace.id);
        if (index < 0) {
          // A completion whose start was missed — a reconnect that began mid
          // call. It goes last, as it would have anyway.
          return {
            ...turn,
            tools: [...turn.tools, { after: turn.responses.length - 1, id: event.trace.id, trace: event.trace }],
          };
        }
        return {
          ...turn,
          tools: turn.tools.map((tool, position) => position === index
            ? { ...tool, trace: completeTrace(tool.trace, event.trace) }
            : tool),
        };
      });

    case "subagent.updated": {
      // A snapshot for a child already on the timeline updates it in place, so
      // its line keeps the response it was delegated from. The first snapshot
      // opens the line on the newest turn, exactly as `tool.started` does.
      const existing = advanced.turns.some((turn) =>
        turn.subagents.some((entry) => entry.subagent.id === event.subagent.id));
      if (existing) return withSubagent(advanced, event);
      return withTurn(advanced, newestTurn(advanced), (turn) => ({
        ...turn,
        subagents: [...turn.subagents, { after: turn.responses.length - 1, subagent: event.subagent }],
      }));
    }

    case "subagent.step":
    case "subagent.usage":
      // These refine a snapshot that has already arrived. With no snapshot
      // there is no task description to name the line with, so the event is
      // dropped rather than guessed at.
      return withSubagent(advanced, event);

    case "permission.required":
    case "permission.resolved":
      // Both carry the same `PermissionRequest` snapshot; `permission.resolved`
      // is the same request with a decision on it.
      return { ...advanced, permissions: mergePermission(advanced.permissions, event.request) };

    case "run.status":
      return {
        ...advanced,
        ...runTimes(advanced, event.run),
        status: event.status,
        terminal: advanced.terminal || isTerminalRunStatus(event.status),
      };

    case "run.completed":
      // The persisted message, not the assembled deltas, is the answer of
      // record: a truncated snapshot may have left the buffer short.
      return {
        ...advanced,
        finalContent: event.message.content,
        status: "completed",
        turns: sealOpenResponses(advanced.turns),
      };

    case "run.failed":
      return { ...advanced, error: { code: event.errorCode, message: event.error } };

    case "run.cancelled":
      // This type appears twice in the union with different payloads; both
      // carry `reason`, and only one carries a run id.
      return { ...advanced, cancelledReason: event.reason ?? TEXT.conversation.cancelledReason };

    case "run.history.truncated":
      return { ...advanced, droppedEvents: advanced.droppedEvents + event.droppedEvents };

    default:
      if (DEFERRED_EVENT_TYPES.has(event.type) || STREAMED_ELSEWHERE.has(event.type)) return advanced;
      return { ...advanced, unknownEvents: advanced.unknownEvents + 1 };
  }
}

/** The turn a tool event belongs to: the newest one, or turn 1 if the call
 *  somehow arrived before any model output. */
function newestTurn(state: RunStreamState): number {
  return state.turns.at(-1)?.turn ?? 1;
}

/**
 * The run's wall-clock span, read off whichever `SessionRun` snapshot arrived.
 *
 * Both the queueing event and every status change carry the whole record, so
 * there is no single event to read this from and no guarantee the one that has
 * the answer comes first. What is recorded never gets overwritten — a snapshot
 * that happens not to carry `finishedAt` is not news that the run is unfinished
 * again — and a run that was cancelled before it ever started reports the wait,
 * which is the only span it had.
 */
function runTimes(
  state: RunStreamState,
  run: { createdAt?: string; finishedAt?: string; startedAt?: string } | undefined,
): { finishedAt?: number; startedAt?: number } {
  const times: { finishedAt?: number; startedAt?: number } = {};
  if (run === undefined) return times;
  const started = state.startedAt ?? timestampOf(run.startedAt ?? run.createdAt);
  const finished = state.finishedAt ?? timestampOf(run.finishedAt);
  if (started !== undefined) times.startedAt = started;
  if (finished !== undefined) times.finishedAt = finished;
  return times;
}

function timestampOf(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? undefined : time;
}

/**
 * Fold a completion trace onto the one the start event left behind.
 *
 * The completion event no longer repeats the arguments, so `args` and `input`
 * come from the start. The spread order still lets the incoming trace win:
 * older records do ship the arguments again, and when they do, that copy is
 * the authoritative one.
 */
function completeTrace(started: ToolTrace, completed: ToolTrace): ToolTrace {
  return {
    ...(started.args !== undefined ? { args: started.args } : {}),
    ...(started.input !== undefined
      ? { input: started.input, ...(started.inputTruncated ? { inputTruncated: true } : {}) }
      : {}),
    ...completed,
  };
}

/** The stream ended. Anything still open was cut off rather than settled. */
export function closeRunStream(state: RunStreamState): RunStreamState {
  return { ...state, terminal: true, turns: sealOpenResponses(state.turns) };
}

function blankResponse(responseId?: string): AssistantResponse {
  return responseId === undefined
    ? { content: "", settled: false, truncated: false }
    : { content: "", responseId, settled: false, truncated: false };
}

function replaceTurn(turns: AssistantTurn[], turn: number, next: AssistantTurn): AssistantTurn[] {
  const index = turns.findIndex((candidate) => candidate.turn === turn);
  if (index < 0) return [...turns, next].sort((left, right) => left.turn - right.turn);
  return turns.map((candidate, position) => (position === index ? next : candidate));
}

function withTurn(
  state: RunStreamState,
  turn: number,
  update: (current: AssistantTurn) => AssistantTurn,
): RunStreamState {
  const current = turnFor(state, turn);
  const next = update(current);
  return next === current ? state : { ...state, turns: replaceTurn(state.turns, turn, next) };
}

/**
 * Apply a subagent event to the turn that already holds its line.
 *
 * Subagents are placed at delegation time, so a later update must find the
 * existing entry rather than append a second one to the newest turn. Returning
 * the state unchanged means no turn owns it yet — only `subagent.updated` is
 * allowed to open a line, and its caller handles that case.
 */
function withSubagent(state: RunStreamState, event: SubagentEvent): RunStreamState {
  const subagentId = event.type === "subagent.updated" ? event.subagent.id : event.subagentId;
  for (let turnIndex = 0; turnIndex < state.turns.length; turnIndex += 1) {
    const turn = state.turns[turnIndex]!;
    const index = turn.subagents.findIndex((entry) => entry.subagent.id === subagentId);
    if (index < 0) continue;
    const current = turn.subagents[index]!.subagent;
    const next = applySubagentEvent(current, event);
    if (next === undefined || next === current) return state;
    return {
      ...state,
      turns: state.turns.map((candidate, candidateIndex) => candidateIndex === turnIndex
        ? {
            ...candidate,
            subagents: candidate.subagents.map((entry, entryIndex) =>
              entryIndex === index ? { ...entry, subagent: next } : entry),
          }
        : candidate),
    };
  }
  return state;
}

/**
 * Route a text frame to its response.
 *
 * `responseId` is the reliable key and is preferred. Older records omit it, so
 * an unidentified frame lands on the newest response of the newest turn — the
 * place it would have landed had the identity existed. A frame that arrives
 * before its `assistant.response.started`, or with no open response at all,
 * opens a block rather than dropping the text.
 */
function withResponse(
  state: RunStreamState,
  responseId: string | undefined,
  update: (current: AssistantResponse) => AssistantResponse,
): RunStreamState {
  const turn = locateTurn(state, responseId);
  if (!turn) {
    const created: AssistantTurn = {
      responses: [update(blankResponse(responseId))],
      subagents: [],
      thinking: "",
      thinkingTruncated: false,
      tools: [],
      turn: 1,
    };
    return { ...state, turns: replaceTurn(state.turns, 1, created) };
  }
  const index = responseIndex(turn, responseId);
  if (index < 0) {
    return {
      ...state,
      turns: replaceTurn(state.turns, turn.turn, {
        ...turn,
        responses: [...turn.responses, update(blankResponse(responseId))],
      }),
    };
  }
  const current = turn.responses[index]!;
  return {
    ...state,
    turns: replaceTurn(state.turns, turn.turn, {
      ...turn,
      responses: turn.responses.map((candidate, position) =>
        position === index ? update(current) : candidate),
    }),
  };
}

function locateTurn(state: RunStreamState, responseId: string | undefined): AssistantTurn | undefined {
  if (responseId !== undefined) {
    const owner = state.turns.find((turn) =>
      turn.responses.some((response) => response.responseId === responseId));
    if (owner) return owner;
  }
  return state.turns.at(-1);
}

function responseIndex(turn: AssistantTurn, responseId: string | undefined): number {
  if (responseId === undefined) return turn.responses.length - 1;
  return turn.responses.findIndex((response) => response.responseId === responseId);
}

function sealOpenResponses(turns: AssistantTurn[]): AssistantTurn[] {
  return turns.map((turn) => ({
    ...turn,
    responses: turn.responses.map((response) =>
      response.settled ? response : { ...response, settled: true }),
  }));
}
