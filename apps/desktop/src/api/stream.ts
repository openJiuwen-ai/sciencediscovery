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
 * The most characters one frame may hold before the decoder gives up on it.
 *
 * Nothing bounds a frame's size on the wire: a writer that opens a frame and
 * never sends its blank line makes the buffer grow for as long as the stream
 * stays open. This ceiling is what stops that, so it sits far above the
 * largest frame a healthy server really sends rather than near it. What the
 * inputs are bounded by: the API accepts request bodies up to `MAX_BODY_BYTES`
 * (1.5 MB, `services/api/src/http/body.ts`), a whole tool result is cut at
 * `DEFAULT_TOOL_OUTPUT_MAX_BYTES` (50 KiB), a workspace listing stops at 500
 * entries (about 125 KB of paths and sizes), and `artifact.upserted` carries a
 * CAS reference rather than the artifact's bytes. The largest legitimate frame
 * is therefore a long model report — a few hundred KiB even with a raised
 * token budget — so 8 MiB leaves well over an order of magnitude of headroom.
 */
export const MAX_FRAME_CHARACTERS = 8 * 1024 * 1024;

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

  /** Cursors of frames given up on since the last call, oldest first. */
  private skipped: (number | undefined)[] = [];

  /** A `\r` that ended the last chunk, waiting for the `\n` that may open the
   *  next one. Only newly arrived text is normalized, so the split has to be
   *  carried rather than re-scanned in place. */
  private pendingCarriageReturn = false;

  /** Set while skipping to the blank line that ends a frame already given up
   *  on: the bytes in between belong to no frame. */
  private discarding = false;

  /** A `\n` that ended the last chunk while discarding, waiting for the `\n`
   *  that may open the next one. A blank line is two bytes and a chunk
   *  boundary can land between them, so the discard carries the first. */
  private sawOneNewlineWhileDiscarding = false;

  /** Offset in `buffer` from which the next `\n\n` is still unknown. Without
   *  it every chunk would re-scan the whole partial frame. */
  private unscanned = 0;

  /** Frames completed by this chunk. A partial tail is retained. */
  push(chunk: string): SseFrame[] {
    // Normalize only what just arrived: the retained buffer was normalized
    // when it was appended, and replacing it again on every chunk would make
    // the work grow with the frame's size times the number of chunks.
    if (this.pendingCarriageReturn) {
      chunk = `\r${chunk}`;
      this.pendingCarriageReturn = false;
    }
    if (chunk.endsWith("\r")) {
      this.pendingCarriageReturn = true;
      chunk = chunk.slice(0, -1);
    }
    chunk = chunk.replace(/\r\n/g, "\n");
    // An empty chunk after normalization carries no information, and returning
    // here is what keeps the discard carry: a lone "\r" normalizes to "" and
    // must not be allowed to clear `sawOneNewlineWhileDiscarding`, or the next
    // chunk's own blank line is taken as the dropped frame's terminator.
    if (chunk === "") return [];
    if (this.discarding) {
      // The carried `\n` wins over an in-chunk `\n\n`: when the last chunk
      // ended with `\n` and this one opens with `\n`, those two bytes are the
      // blank line that closes the dropped frame — even if the rest of this
      // chunk is a complete later frame whose own `\n\n` would otherwise be
      // taken as the terminator and swallow that frame.
      if (this.sawOneNewlineWhileDiscarding && chunk.startsWith("\n")) {
        this.discarding = false;
        this.sawOneNewlineWhileDiscarding = false;
        chunk = chunk.slice(1);
      } else {
        const boundary = chunk.indexOf("\n\n");
        if (boundary < 0) {
          // No blank line yet: the bytes belong to the frame given up on.
          this.sawOneNewlineWhileDiscarding = chunk.endsWith("\n");
          return [];
        }
        this.discarding = false;
        this.sawOneNewlineWhileDiscarding = false;
        chunk = chunk.slice(boundary + 2);
      }
    }
    this.buffer += chunk;
    return this.drain(false);
  }

  /** Frames left over when the stream ends without a final blank line. */
  flush(): SseFrame[] {
    // A `\r` held back at the very end was part of the last frame's text.
    if (this.pendingCarriageReturn) {
      this.buffer += "\r";
      this.pendingCarriageReturn = false;
    }
    return this.drain(true);
  }

  /** Ids of frames the decoder had to drop, handing them over once. */
  takeSkipped(): (number | undefined)[] {
    const skipped = this.skipped;
    this.skipped = [];
    return skipped;
  }

  private drain(flush: boolean): SseFrame[] {
    const frames: SseFrame[] = [];
    let boundary = this.buffer.indexOf("\n\n", this.unscanned);
    while (boundary >= 0) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.unscanned = 0;
      if (raw.length > MAX_FRAME_CHARACTERS) {
        // A frame that already arrived over the ceiling is as unreadable as
        // one that never closes: parsing it would spend the memory again.
        this.skipped.push(frameCursor(raw));
      } else {
        const frame = parseFrame(raw);
        if (frame) frames.push(frame);
      }
      boundary = this.buffer.indexOf("\n\n", this.unscanned);
    }
    if (flush && this.buffer.trim() !== "") {
      const raw = this.buffer;
      this.buffer = "";
      this.unscanned = 0;
      if (raw.length > MAX_FRAME_CHARACTERS) this.skipped.push(frameCursor(raw));
      else {
        const frame = parseFrame(raw);
        if (frame) frames.push(frame);
      }
    }
    // A lone trailing newline can be the first half of the blank line that
    // closes a frame whose content is exactly at the ceiling: that byte is
    // framing, not payload, and must not push the frame over the cap.
    const retained = this.buffer.endsWith("\n") ? this.buffer.length - 1 : this.buffer.length;
    if (!flush && retained > MAX_FRAME_CHARACTERS) {
      // Past the ceiling with no terminator in sight: give up on this frame,
      // keep the cursor it carried so a reconnect moves past it, and skip to
      // the next blank line instead of holding bytes for nobody.
      this.skipped.push(frameCursor(this.buffer));
      this.buffer = "";
      this.unscanned = 0;
      this.discarding = true;
      this.sawOneNewlineWhileDiscarding = false;
    } else if (boundary < 0) {
      // Nothing new to find before the last character; a `\n\n` can still
      // straddle the next append.
      this.unscanned = Math.max(0, this.buffer.length - 1);
    }
    return frames;
  }
}

/** The replay cursor a frame carried, read from the lines that were fully
 *  received before the frame was given up on. The last fully received `id:`
 *  line wins, as it does in `parseFrame`; taking the first would move the
 *  client backwards past frames it already saw.
 *
 *  A dropped frame must only move the cursor by what it actually read: an
 *  `id:` line still waiting for its newline can be the prefix of a longer
 *  number, so it is not evidence of a frame the server finished writing. */
function frameCursor(raw: string): number | undefined {
  let cursor: number | undefined;
  let start = 0;
  while (start < raw.length) {
    const end = raw.indexOf("\n", start);
    // The rest of this line never arrived: it proves nothing, but every `id:`
    // line before it was read in full.
    if (end < 0) break;
    const line = raw.slice(start, end);
    if (line.startsWith("id:")) {
      const parsed = Number(line.slice(3).trim());
      if (Number.isFinite(parsed)) cursor = parsed;
    }
    start = end + 1;
  }
  return cursor;
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
      // Frames the decoder gave up on while they were still arriving are the
      // same class of loss as the ones above: counted, cursor handed over.
      for (const id of frames.takeSkipped()) {
        skipped += 1;
        onEvent(null, id);
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
