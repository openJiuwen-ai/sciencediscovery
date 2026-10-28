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

import type { ApiClient } from "./client.js";
import type { RunStreamEvent, SendMessageRequest, SessionRunEvent } from "./types.js";
import { TEXT } from "../text.js";

/**
 * One decoded SSE frame. `id` is the server's replay cursor: it is what a
 * reconnect sends as `?after=`, so a frame without one must never advance it.
 */
export interface SseFrame {
  data: string;
  id?: number;
}

/**
 * Turns a byte stream into frames.
 *
 * The API writes `id: <n>\n` followed by `data: <json>\n\n`, so a frame is
 * everything up to a blank line. Two details matter beyond the happy path:
 * comment lines (`:` …) are keep-alives and carry no event, and a frame that
 * is still arriving must stay in the buffer rather than be parsed early — a
 * chunk boundary can land anywhere, including between `\r` and `\n`.
 */
export class SseFrameDecoder {
  private buffer = "";

  /** Frames completed by this chunk. A partial tail is retained. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  /** Frames left over when the stream ends without a final blank line. */
  flush(): SseFrame[] {
    return this.drain(true);
  }

  private drain(flush: boolean): SseFrame[] {
    const frames: SseFrame[] = [];
    // Normalize up front so a proxy that rewrites line endings cannot break
    // framing. Safe for the payload: JSON escapes literal newlines.
    this.buffer = this.buffer.replace(/\r\n/g, "\n");
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
      boundary = this.buffer.indexOf("\n\n");
    }
    if (flush && this.buffer.trim() !== "") {
      const frame = parseFrame(this.buffer);
      this.buffer = "";
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

function parseFrame(raw: string): SseFrame | undefined {
  const data: string[] = [];
  let id: number | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("id:")) {
      const parsed = Number(line.slice(3).trim());
      if (Number.isFinite(parsed)) id = parsed;
      continue;
    }
    if (line.startsWith("data:")) {
      // Exactly one optional leading space is part of the framing, not data.
      data.push(line.slice(5).replace(/^ /, ""));
      continue;
    }
    // `event:`, `retry:` and unknown fields are not used by this API.
  }
  if (data.length === 0) return undefined;
  return id === undefined ? { data: data.join("\n") } : { data: data.join("\n"), id };
}

/** Called for every event with the cursor that came with it, if any. Callers
 *  keep the largest value they saw and reconnect with it.
 *
 *  `event` is `null` for a frame whose payload could not be read: there is
 *  nothing to fold in, but the cursor it carried still has to move. */
export type RunEventHandler = (event: RunStreamEvent | null, sequence?: number) => void;

/** What a stream reports about itself while it runs. */
export interface StreamOptions {
  /**
   * Called once, when the stream ends, with the number of frames it could not
   * read. Those frames are skipped — the stream carries on and their cursors
   * move past them — but the run is missing that part, and one notice for the
   * whole stream is the point: not one per frame.
   */
  onSkippedFrames?: (count: number) => void;
}

async function pump(
  response: Response,
  onEvent: RunEventHandler,
  onSkippedFrames?: (count: number) => void,
): Promise<void> {
  if (!response.body) throw new Error(TEXT.errors.noStream);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = new SseFrameDecoder();
  let skipped = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      const decoded = frames.push(decoder.decode(value, { stream: !done }));
      // The last chunk may end without the blank line that closes a frame.
      for (const frame of done ? [...decoded, ...frames.flush()] : decoded) {
        let event: RunStreamEvent;
        try {
          event = JSON.parse(frame.data) as RunStreamEvent;
        } catch {
          // The payload never became an event. The server is still writing and
          // the frames after this one are still good, so this frame is counted
          // and stepped over rather than thrown from. Its cursor is handed on
          // all the same: a reconnect asks for `?after=`, and a cursor left
          // behind would fetch this same unreadable frame again, forever.
          skipped += 1;
          onEvent(null, frame.id);
          continue;
        }
        // A handler's own exception is this app's bug, not a bad frame: it is
        // deliberately left to reach the caller's error path.
        onEvent(event, frame.id);
      }
      if (done) break;
    }
  } finally {
    // Aborting errors the body stream; release the reader either way.
    await reader.cancel().catch(() => undefined);
  }
  // One notice for the whole stream, and only when it ended on its own: a
  // stream that failed or was stopped has its own outcome to report.
  if (skipped > 0) onSkippedFrames?.(skipped);
}

/**
 * Send one message and stream the run it starts. The server closes this
 * response on the run's terminal `run.status` event.
 *
 * The response never carries the run id — it only appears inside the
 * `run.queued` / `run.started` payloads, so the caller has to pick it up from
 * the event stream to be able to resume or cancel.
 */
export async function streamMessage(
  client: ApiClient,
  sessionId: string,
  body: SendMessageRequest,
  onEvent: RunEventHandler,
  signal?: AbortSignal,
  options?: StreamOptions,
): Promise<void> {
  const response = await client.fetchStream(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    body: JSON.stringify(body),
    method: "POST",
    ...(signal ? { signal } : {}),
  });
  await pump(response, onEvent, options?.onSkippedFrames);
}

/**
 * Follow an existing run from a replay cursor. Passing a non-terminal run's
 * last known `sequence` replays what was missed and then goes live; passing 0
 * on a finished run replays it whole for rebuilding the timeline.
 */
export async function subscribeRunEvents(
  client: ApiClient,
  sessionId: string,
  runId: string,
  after: number,
  onEvent: RunEventHandler,
  signal?: AbortSignal,
  options?: StreamOptions,
): Promise<void> {
  const response = await client.fetchStream(
    `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/events?after=${after}`,
    {
      headers: { accept: "text/event-stream" },
      ...(signal ? { signal } : {}),
    },
  );
  await pump(response, onEvent, options?.onSkippedFrames);
}

/** The same events as JSON, for rebuilding a run that already finished. */
export function listRunEvents(
  client: ApiClient,
  sessionId: string,
  runId: string,
  after = 0,
): Promise<SessionRunEvent[]> {
  return client.request<SessionRunEvent[]>(
    `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/events?after=${after}`,
  );
}

/**
 * Read a tool's output back from its own substream, as text.
 *
 * This is the third way into a run's events and the only one that is not SSE.
 * The reason is that it is a *different* stream: a tool's result is appended to
 * `tool-<toolCallId>` and the run's own event route never replays it — a
 * finished run read back with `?after=0` contains no `tool.output` at all, only
 * the `tool.completed` trace pointing at the substream. The live response does
 * carry copies of those frames, so a card must prefer whichever it already has
 * and only come here for what it does not.
 *
 * The concatenated `chunk` fields are the whole body: no framing, no per-chunk
 * metadata survives into the UI.
 *
 * A tool that reports progress appends those frames to this same stream, and
 * the final result normally repeats their text. Joining every chunk would print
 * the output twice, so progress and result are kept apart — the split
 * `apps/web` makes — and the rule separator only appears when both exist.
 */
export async function readToolOutput(
  client: ApiClient,
  sessionId: string,
  runId: string,
  streamId: string,
  after = 0,
): Promise<string | undefined> {
  const events = await client.request<SessionRunEvent[]>(
    `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`
    + `/streams/${encodeURIComponent(streamId)}/events?after=${after}`,
  );
  const outputs = events
    .map((record) => record.event)
    .filter((event): event is Extract<RunStreamEvent, { type: "tool.output" }> => event.type === "tool.output");
  const progress = outputs
    .filter((event) => event.progress === true)
    .map((event) => event.chunk)
    .join("");
  const result = outputs
    .filter((event) => event.progress !== true)
    .map((event) => event.chunk)
    .join("");
  if (progress !== "" && result !== "") return `${progress}\n\n---\n\n${result}`;
  return progress || result || undefined;
}
