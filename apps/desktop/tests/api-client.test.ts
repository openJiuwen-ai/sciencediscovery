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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { ApiClient, ApiRequestError, isAbortError, isAuthFailure } from "../src/api/client.js";
import { testModel } from "../src/api/models.js";
import { MAX_FRAME_CHARACTERS, SseFrameDecoder, readToolOutput, streamMessage } from "../src/api/stream.js";
import type { RunStreamEvent, SessionRunEvent } from "../src/api/types.js";

/** Replace `globalThis.fetch` for one test, restore it afterwards, and hand
 *  back what the client actually sent. */
async function withFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
): Promise<{ init: RequestInit; url: string }[]> {
  const original = globalThis.fetch;
  const calls: { init: RequestInit; url: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const resolved = init ?? {};
    calls.push({ init: resolved, url });
    return handler(url, resolved);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

/** A response whose body is an event stream, delivered in the given chunks —
 *  the shape the API writes it in. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** One frame of an event stream, as the pump delivered it. A `null` event is
 *  a frame whose payload could not be read: the pump still hands over the
 *  cursor it carried so a reconnect does not ask for it again. */
interface Seen {
  event: RunStreamEvent | null;
  sequence?: number;
}

test("every request carries the bearer token, including streamed ones", async () => {
  const seen: RequestInit[] = [];
  const client = new ApiClient("secret-token");

  await withFetch(
    (_url, init) => {
      seen.push(init);
      return Promise.resolve(jsonResponse({ ok: true }));
    },
    async () => {
      await client.request("/api/models");
      await client.request("/api/sessions", { body: "{}", method: "POST" });
      await client.fetchStream("/api/sessions/one/runs/two/events?after=0");
    },
  );

  assert.equal(seen.length, 3);
  const headers = (init: RequestInit | undefined) =>
    (init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers(seen[0]).authorization, "Bearer secret-token");
  assert.equal(headers(seen[1]).authorization, "Bearer secret-token");
  assert.equal(headers(seen[2]).authorization, "Bearer secret-token");
  // Only a body gets a content-type: an SSE GET with one would be wrong.
  assert.equal(headers(seen[0])["content-type"], undefined);
  assert.equal(headers(seen[1])["content-type"], "application/json");
  assert.equal(headers(seen[2])["content-type"], undefined);
});

test("a 401 is reported to the caller and stays distinguishable from other failures", async () => {
  let rejected = 0;
  const client = new ApiClient("stale", () => {
    rejected += 1;
  });

  await withFetch(
    () => Promise.resolve(jsonResponse({ error: "unauthorized" }, 401)),
    async () => {
      await assert.rejects(
        () => client.request("/api/models"),
        (reason: unknown) => {
          assert.ok(isAuthFailure(reason));
          const error = reason as ApiRequestError;
          assert.equal(error.status, 401);
          assert.equal(error.message, "unauthorized");
          return true;
        },
      );
    },
  );
  assert.equal(rejected, 1);

  await withFetch(
    () => Promise.resolve(jsonResponse({ error: "boom" }, 500)),
    async () => {
      await assert.rejects(
        () => client.request("/api/models"),
        (reason: unknown) => {
          // A 5xx must never be mistaken for a credential problem: the two lead
          // to opposite instructions.
          assert.equal(isAuthFailure(reason), false);
          return true;
        },
      );
    },
  );
  assert.equal(rejected, 1);
});

test("a non-JSON error body still produces a readable message", async () => {
  const client = new ApiClient("t");
  await withFetch(
    () => Promise.resolve(new Response("<html>502</html>", { status: 502 })),
    async () => {
      await assert.rejects(
        () => client.request("/api/models"),
        (reason: unknown) => {
          assert.equal((reason as ApiRequestError).message, "Request failed (502)");
          return true;
        },
      );
    },
  );
});

test("the error code and details survive so a caller can act on them", async () => {
  const client = new ApiClient("t");
  await withFetch(
    () =>
      Promise.resolve(
        jsonResponse({ code: "run_active", details: { sessions: ["a"] }, error: "busy" }, 409),
      ),
    async () => {
      await assert.rejects(
        () => client.request("/api/projects/p", { method: "DELETE" }),
        (reason: unknown) => {
          const error = reason as ApiRequestError;
          assert.equal(error.code, "run_active");
          assert.deepEqual(error.details, { sessions: ["a"] });
          return true;
        },
      );
    },
  );
});

test("frames split across chunk boundaries are held until the blank line", () => {
  const decoder = new SseFrameDecoder();
  // A boundary can land mid-number, mid-JSON, or between \r and \n.
  assert.deepEqual(decoder.push("id: 1\ndata: {\"type\":\"run.que"), []);
  assert.deepEqual(decoder.push("ued\"}\n\n"), [{ data: '{"type":"run.queued"}', id: 1 }]);
  assert.deepEqual(decoder.push("id: 2\r\ndata: {}\r\n\r\n"), [{ data: "{}", id: 2 }]);
});

test("several frames in one chunk arrive in order", () => {
  const decoder = new SseFrameDecoder();
  const frames = decoder.push("id: 1\ndata: a\n\nid: 2\ndata: b\n\nid: 3\ndata: c\n\n");
  assert.deepEqual(frames, [
    { data: "a", id: 1 },
    { data: "b", id: 2 },
    { data: "c", id: 3 },
  ]);
});

test("comment keep-alives carry no event and do not advance the cursor", () => {
  const decoder = new SseFrameDecoder();
  // `: ping` is what the server sends while a run is quiet. Emitting it as an
  // event would make the reducer count it as unknown; worse, treating it as a
  // frame would reset the replay cursor.
  assert.deepEqual(decoder.push(": ping\n\n"), []);
  assert.deepEqual(decoder.push(": ping\nid: 7\ndata: x\n\n"), [{ data: "x", id: 7 }]);
});

test("a stream that ends without a final blank line still yields its last frame", () => {
  const decoder = new SseFrameDecoder();
  assert.deepEqual(decoder.push("id: 9\ndata: tail"), []);
  assert.deepEqual(decoder.flush(), [{ data: "tail", id: 9 }]);
  // Flushing twice must not re-emit.
  assert.deepEqual(decoder.flush(), []);
});

test("a frame with no id keeps its data and reports no cursor", () => {
  const decoder = new SseFrameDecoder();
  assert.deepEqual(decoder.push("data: no-id\n\n"), [{ data: "no-id" }]);
});

test("multi-line data fields are joined the way SSE specifies", () => {
  const decoder = new SseFrameDecoder();
  assert.deepEqual(decoder.push("data: one\ndata: two\n\n"), [{ data: "one\ntwo" }]);
});

test("a CRLF split across chunks is still one line break", () => {
  const decoder = new SseFrameDecoder();
  // Only the bytes that just arrived are normalized, so a `\r` at the end of
  // one chunk has to wait for the `\n` that may open the next one.
  assert.deepEqual(decoder.push("id: 2\r"), []);
  assert.deepEqual(decoder.push("\ndata: {}\r"), []);
  assert.deepEqual(decoder.push("\n\r\n"), [{ data: "{}", id: 2 }]);
});

test("a frame that never terminates stops at the cap and is reported as a skipped frame", () => {
  // The repro from the issue: a writer that opens a frame and keeps sending
  // bytes without ever terminating it. Below the ceiling the frame is still
  // assembled as before; past it, nothing may be retained.
  const decoder = new SseFrameDecoder();
  const head = 'id: 4\ndata: {"type":"assistant.delta","delta":"';
  decoder.push(head);
  const filler = "x".repeat(64 * 1024);
  let pushed = head.length;
  while (pushed + filler.length <= MAX_FRAME_CHARACTERS) {
    decoder.push(filler);
    pushed += filler.length;
  }
  decoder.push(filler.slice(0, MAX_FRAME_CHARACTERS - pushed));
  // Exactly at the ceiling is still a frame that may arrive.
  assert.deepEqual(decoder.takeSkipped(), []);
  decoder.push("x");
  // One character past it the frame is given up on, with its cursor kept.
  assert.deepEqual(decoder.takeSkipped(), [4]);
  // And it is gone, not merely hidden: an unbounded decoder would hand this
  // 8 MiB tail to `flush()` when the stream ended.
  assert.deepEqual(decoder.flush(), []);
});

test("the decoder resynchronises at the next blank line after a dropped frame", () => {
  const decoder = new SseFrameDecoder();
  decoder.push('id: 5\ndata: {"type":"assistant.delta","delta":"');
  decoder.push("x".repeat(MAX_FRAME_CHARACTERS + 1));
  assert.deepEqual(decoder.takeSkipped(), [5]);
  // The frame's own tail keeps arriving after the drop. Until its blank line
  // lands, those bytes belong to the frame that was given up on: a `data:` line
  // here is exactly the crafted tail that must never reach the JSON parser (as
  // a frame it would be re-interpreted as a brand-new event).
  assert.deepEqual(decoder.push('data: {"type":"injected"}'), []);
  // One oversized frame is one skip, however many chunks its tail takes.
  assert.deepEqual(decoder.takeSkipped(), []);
  assert.deepEqual(decoder.push("more tail\n"), []);
  assert.deepEqual(decoder.takeSkipped(), []);
  // The blank line that finally arrives ends the frame that was given up on;
  // it is not data and must not close anything else.
  assert.deepEqual(decoder.push("\n\n"), []);
  // A well-formed frame after it arrives untouched, which is what keeps a live
  // run usable after one bad writer.
  assert.deepEqual(decoder.push('id: 6\ndata: {"type":"run.status"}\n\n'), [
    { data: '{"type":"run.status"}', id: 6 },
  ]);
});

test("a dropped frame ends when its blank line arrives split across chunks", () => {
  // A blank line is two bytes and a chunk boundary can land between them. The
  // discard must carry the first newline, or the terminator never matches and
  // the frame after the dropped one is swallowed.
  const decoder = new SseFrameDecoder();
  decoder.push('id: 7\ndata: {"type":"assistant.delta","delta":"');
  decoder.push("x".repeat(MAX_FRAME_CHARACTERS + 1));
  assert.deepEqual(decoder.takeSkipped(), [7]);
  assert.deepEqual(decoder.push("\n"), []);
  // The second newline completes the dropped frame's terminator, so parsing
  // resumes and the next frame is delivered rather than discarded.
  assert.deepEqual(decoder.push("\n"), []);
  assert.deepEqual(decoder.takeSkipped(), []);
  assert.deepEqual(decoder.push('id: 8\ndata: {"type":"run.status"}\n\n'), [
    { data: '{"type":"run.status"}', id: 8 },
  ]);
});

test("a dropped frame does not swallow a complete frame carried in the same chunk", () => {
  // The chunk that closes the dropped frame can also carry the next frame. The
  // carried newline is the blank line's first byte, so it closes the drop; the
  // later `\n\n` in the same chunk belongs to the complete frame and must not
  // be taken as the terminator, which would discard that whole frame.
  const decoder = new SseFrameDecoder();
  decoder.push('id: 7\ndata: {"type":"assistant.delta","delta":"');
  decoder.push("x".repeat(MAX_FRAME_CHARACTERS + 1));
  assert.deepEqual(decoder.takeSkipped(), [7]);
  assert.deepEqual(decoder.push("\n"), []);
  assert.deepEqual(decoder.push('\nid: 8\ndata: {"type":"run.status"}\n\n'), [
    { data: '{"type":"run.status"}', id: 8 },
  ]);
  assert.deepEqual(decoder.takeSkipped(), []);
});

test("an empty chunk does not lose the carried newline while discarding", () => {
  // An empty chunk carries no information. It must not clear the carried `\n`,
  // or the next chunk's own blank line is taken as the dropped frame's
  // terminator and the frame it belongs to is swallowed.
  const decoder = new SseFrameDecoder();
  decoder.push('id: 7\ndata: {"type":"assistant.delta","delta":"');
  decoder.push("x".repeat(MAX_FRAME_CHARACTERS + 1));
  assert.deepEqual(decoder.takeSkipped(), [7]);
  // The dropped frame's tail ends with the blank line's first newline.
  assert.deepEqual(decoder.push("more tail\n"), []);
  assert.deepEqual(decoder.push(""), []);
  assert.deepEqual(decoder.push('\nid: 8\ndata: {"type":"run.status"}\n\n'), [
    { data: '{"type":"run.status"}', id: 8 },
  ]);
  // One dropped frame is one skip.
  assert.deepEqual(decoder.takeSkipped(), []);
});

test("a lone carriage return between the two halves of a blank line keeps the resync", () => {
  // A CRLF blank line can be split by a one-byte read: the lone `\r` arrives
  // as its own chunk and normalizes to "". It must be held for the `\n` that
  // follows, not treated as "this chunk does not end with a newline".
  const decoder = new SseFrameDecoder();
  decoder.push('id: 7\ndata: {"type":"assistant.delta","delta":"');
  decoder.push("x".repeat(MAX_FRAME_CHARACTERS + 1));
  assert.deepEqual(decoder.takeSkipped(), [7]);
  assert.deepEqual(decoder.push("more tail\n"), []);
  assert.deepEqual(decoder.push("\r"), []);
  assert.deepEqual(decoder.push('\nid: 9\ndata: {"type":"run.status"}\n\n'), [
    { data: '{"type":"run.status"}', id: 9 },
  ]);
  assert.deepEqual(decoder.takeSkipped(), []);
});

test("a frame exactly at the ceiling still parses when its terminator is split", () => {
  // The blank line's first `\n` is framing, not payload: at exactly the ceiling
  // it must not push the retained frame over the cap and get the frame dropped.
  const decoder = new SseFrameDecoder();
  const prefix = "id: 9\ndata: ";
  const payload = "z".repeat(MAX_FRAME_CHARACTERS - prefix.length);
  assert.deepEqual(decoder.push(`${prefix}${payload}`), []);
  assert.deepEqual(decoder.takeSkipped(), []);
  // Split terminator: the first newline arrives alone, the second closes it.
  assert.deepEqual(decoder.push("\n"), []);
  assert.deepEqual(decoder.push("\n"), [{ data: payload, id: 9 }]);
  assert.deepEqual(decoder.takeSkipped(), []);
});

test("a dropped frame moves the cursor by the last id line it fully received", () => {
  // `parseFrame` uses the last `id:` line of a frame, so the cursor a dropped
  // frame reports must be read the same way: the first one would move the
  // client backwards past frames it already saw.
  const decoder = new SseFrameDecoder();
  decoder.push("id: 3\nid: 4\n");
  decoder.push("x".repeat(MAX_FRAME_CHARACTERS + 1));
  assert.deepEqual(decoder.takeSkipped(), [4]);
});

test("a dropped frame moves the cursor only by an id line that fully arrived", () => {
  // The `id:` line never got its newline before the frame was given up on, so
  // the digits that did arrive could be the prefix of a longer number. Nothing
  // was read, so a reconnect must not skip past anything.
  const decoder = new SseFrameDecoder();
  decoder.push("id: 1");
  decoder.push("x".repeat(MAX_FRAME_CHARACTERS));
  assert.deepEqual(decoder.takeSkipped(), [undefined]);
});

test("a frame below the ceiling still parses in full", () => {
  const decoder = new SseFrameDecoder();
  // A long report is the biggest event one frame carries: the model's default
  // output budget is 16 384 tokens, so 1 MiB already sits far above real
  // traffic and still nowhere near the ceiling.
  const content = "y".repeat(1024 * 1024);
  const data = JSON.stringify({ content, type: "assistant.snapshot" });
  const frames = decoder.push(`id: 12\ndata: ${data}\n\n`);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.data, data);
  assert.deepEqual(decoder.takeSkipped(), []);
});

test("the frame ceiling is a module constant, not a configurable setting", () => {
  // The ceiling is fixed in the module: no environment variable, no settings
  // field and no constructor option can raise it at runtime.
  assert.equal(MAX_FRAME_CHARACTERS, 8 * 1024 * 1024);
  // A zero-parameter constructor leaves no options object that could carry a
  // cap in, so the only way to change the bound is to edit the module.
  assert.equal(SseFrameDecoder.length, 0);
});

test("a frame the server wrote badly does not end the stream", async () => {
  // The run is still going on the server. One frame with an unreadable payload
  // must not end the response: everything after it still arrives, and the
  // stream ends the way it would have, on the terminal frame.
  const client = new ApiClient("t");
  const seen: Seen[] = [];
  const skips: number[] = [];
  let failure: unknown;
  await withFetch(
    () =>
      Promise.resolve(
        sseResponse([
          'id: 1\ndata: {"type":"run.started","runId":"run-1","model":{"name":"m"},"settings":{}}\n\n',
          // The server wrote a frame whose payload is not JSON at all.
          'id: 2\ndata: {"type":"assistant.delta","delta":"cut\n\n',
          'id: 3\ndata: {"type":"assistant.delta","delta":"after"}\n\n',
          'id: 4\ndata: {"type":"run.status","status":"completed","run":{"id":"run-1","status":"completed"}}\n\n',
        ]),
      ),
    async () => {
      try {
        await streamMessage(
          client,
          "session-1",
          { content: "hi" },
          (event, sequence) => {
            seen.push({ event, sequence });
          },
          undefined,
          { onSkippedFrames: (count) => skips.push(count) },
        );
      } catch (reason) {
        failure = reason;
      }
    },
  );
  // A bad frame is not the stream's outcome.
  assert.equal(failure, undefined);
  // The frames after it still arrived, terminal one included.
  assert.deepEqual(seen.map((entry) => entry.sequence), [1, 2, 3, 4]);
  assert.equal(seen[0].event?.type, "run.started");
  assert.equal(seen[2].event?.type, "assistant.delta");
  assert.equal(seen[3].event?.type, "run.status");
  // The unreadable frame is handed over as a cursor and nothing else. A
  // reconnect asks for `?after=`, so a cursor left behind would fetch this
  // same frame again, forever.
  assert.equal(seen[1].event, null);
  assert.equal(seen[1].sequence, 2);
  // One notice for the whole stream, not one per frame.
  assert.deepEqual(skips, [1]);
});

test("a live stream keeps delivering frames after an unterminated one is dropped", async () => {
  // The same shape against the pump: a writer opens a frame, sends bytes for a
  // while without its blank line, then recovers. The stream has to carry on,
  // count the lost frame once, and deliver what follows it.
  const client = new ApiClient("t");
  const seen: Seen[] = [];
  const skips: number[] = [];
  const filler = "x".repeat(64 * 1024);
  const chunks = [
    'id: 1\ndata: {"type":"run.started","runId":"run-1","model":{"name":"m"},"settings":{}}\n\n',
    'id: 2\ndata: {"type":"assistant.delta","delta":"',
  ];
  for (let sent = 0; sent <= MAX_FRAME_CHARACTERS; sent += filler.length) chunks.push(filler);
  chunks.push("\n\n");
  chunks.push('id: 3\ndata: {"type":"assistant.delta","delta":"after"}\n\n');
  chunks.push('id: 4\ndata: {"type":"run.status","status":"completed","run":{"id":"run-1","status":"completed"}}\n\n');
  await withFetch(
    () => Promise.resolve(sseResponse(chunks)),
    async () => {
      await streamMessage(
        client,
        "session-1",
        { content: "hi" },
        (event, sequence) => {
          seen.push({ event, sequence });
        },
        undefined,
        { onSkippedFrames: (count) => skips.push(count) },
      );
    },
  );
  assert.deepEqual(seen.map((entry) => entry.sequence), [1, 2, 3, 4]);
  assert.equal(seen[0].event?.type, "run.started");
  // The dropped frame moves the cursor and nothing else.
  assert.equal(seen[1].event, null);
  assert.equal(seen[2].event?.type, "assistant.delta");
  assert.equal(seen[3].event?.type, "run.status");
  assert.deepEqual(skips, [1]);
});

test("several unreadable frames are reported once, with the total", async () => {
  const client = new ApiClient("t");
  const seen: Seen[] = [];
  const skips: number[] = [];
  await withFetch(
    () =>
      Promise.resolve(
        sseResponse([
          'id: 1\ndata: {oops\n\n',
          'id: 2\ndata: {oops\n\n',
          'id: 3\ndata: {"type":"run.status","status":"completed","run":{"id":"run-1","status":"completed"}}\n\n',
        ]),
      ),
    async () => {
      await streamMessage(client, "session-1", { content: "hi" }, (event, sequence) => {
        seen.push({ event, sequence });
      }, undefined, { onSkippedFrames: (count) => skips.push(count) });
    },
  );
  assert.deepEqual(seen.map((entry) => entry.sequence), [1, 2, 3]);
  assert.deepEqual(skips, [2]);
});

test("a clean stream delivers every frame and says nothing about skips", async () => {
  const client = new ApiClient("t");
  const seen: Seen[] = [];
  const skips: number[] = [];
  await withFetch(
    () =>
      Promise.resolve(
        sseResponse([
          'id: 1\ndata: {"type":"assistant.delta","delta":"hello"}\n\n',
          'id: 2\ndata: {"type":"run.status","status":"completed","run":{"id":"run-1","status":"completed"}}\n\n',
        ]),
      ),
    async () => {
      await streamMessage(client, "session-1", { content: "hi" }, (event, sequence) => {
        seen.push({ event, sequence });
      }, undefined, { onSkippedFrames: (count) => skips.push(count) });
    },
  );
  assert.deepEqual(seen.map((entry) => entry.sequence), [1, 2]);
  assert.equal(seen[0].event?.type, "assistant.delta");
  assert.equal(seen[1].event?.type, "run.status");
  assert.deepEqual(skips, []);
});

test("an exception from the event handler is not swallowed", async () => {
  // A bug in the handler is this app's bug, not the server's bad frame: it has
  // to reach the caller's error path rather than be counted as unreadable.
  const client = new ApiClient("t");
  const boom = new Error("handler failed");
  const skips: number[] = [];
  await withFetch(
    () => Promise.resolve(sseResponse(['id: 1\ndata: {"type":"run.started","runId":"run-1","model":{"name":"m"},"settings":{}}\n\n'])),
    async () => {
      await assert.rejects(
        streamMessage(client, "session-1", { content: "hi" }, () => {
          throw boom;
        }, undefined, { onSkippedFrames: (count) => skips.push(count) }),
        (reason: unknown) => reason === boom,
      );
    },
  );
  assert.deepEqual(skips, []);
});

test("abort detection is by name, which is all fetch guarantees", () => {
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(isAbortError(abort), true);
  assert.equal(isAbortError(new Error("boom")), false);
  assert.equal(isAbortError(undefined), false);
});

/** One substream record. The substream is where a tool's progress and result
 *  frames land, in the order the run wrote them. */
const outputRecord = (event: RunStreamEvent, sequence: number): SessionRunEvent => ({
  createdAt: "2026-10-23T00:00:00Z",
  event,
  runId: "run-1",
  sequence,
  sessionId: "session-1",
});

async function readOutput(events: SessionRunEvent[]): Promise<string | undefined> {
  const client = new ApiClient("t");
  let text: string | undefined;
  await withFetch(
    () => Promise.resolve(jsonResponse(events)),
    async () => {
      text = await readToolOutput(client, "session-1", "run-1", "tool-1");
    },
  );
  return text;
}

test("progress frames are not repeated on top of the tool's result", async () => {
  // The server writes `progress: true` frames to the same substream as the
  // result, and the result repeats their text. Joining everything would show
  // the same output twice.
  const text = await readOutput([
    outputRecord({ chunk: "line1\n", progress: true, toolCallId: "c1", type: "tool.output" }, 1),
    outputRecord({ chunk: "line2\n", progress: true, toolCallId: "c1", type: "tool.output" }, 2),
    outputRecord({ chunk: "line1\nline2\n", toolCallId: "c1", type: "tool.output" }, 3),
  ]);
  assert.equal(text, "line1\nline2\n\n\n---\n\nline1\nline2\n");
});

test("a result-only substream reads as its own body", async () => {
  const text = await readOutput([
    outputRecord({ chunk: "the answer\n", toolCallId: "c1", type: "tool.output" }, 1),
  ]);
  assert.equal(text, "the answer\n");
});

test("progress without a result is still shown, and an empty substream is undefined", async () => {
  const progressOnly = await readOutput([
    outputRecord({ chunk: "working\n", progress: true, toolCallId: "c1", type: "tool.output" }, 1),
  ]);
  assert.equal(progressOnly, "working\n");
  assert.equal(await readOutput([]), undefined);
});

test("a model check states the consent the service requires", async () => {
  // Without this body the service rejects the request before it ever reaches
  // the provider, and the setup wizard reported that rejection as the model's
  // own failure.
  const client = new ApiClient("secret-token");
  const calls = await withFetch(
    () => Promise.resolve(jsonResponse({ category: "ok", latencyMs: 1, message: "", ok: true, testedAt: "" })),
    async () => {
      await testModel(client, "model/one");
      await testModel(client, "model/one", true);
    },
  );
  assert.ok(calls[0]!.url.endsWith("/api/models/model%2Fone/test"), calls[0]!.url);
  assert.equal(calls[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { compatibility: false, consent: true });
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { compatibility: true, consent: true });
});
