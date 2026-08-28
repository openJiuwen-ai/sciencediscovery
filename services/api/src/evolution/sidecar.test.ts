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

import assert from "node:assert/strict";
import { test } from "node:test";

import type { EvolveEventRecord } from "@sciencediscovery/schema";

import { parseNdjsonStream, refusal } from "./sidecar.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[], warn?: (message: string) => void) {
  const records = [];
  for await (const record of parseNdjsonStream(streamOf(chunks), warn)) records.push(record);
  return records;
}

const LINE = (sequence: number) =>
  `${JSON.stringify({ createdAt: "2026-08-19T00:00:00.000Z", event: { level: "info", message: "x", type: "log" }, sequence })}\n`;

test("a record split across chunk boundaries is not lost", async () => {
  const whole = LINE(1) + LINE(2) + LINE(3);
  const cut = Math.floor(whole.length / 2);
  const records = await collect([whole.slice(0, cut), whole.slice(cut)]);
  assert.deepEqual(records.map((record) => record.sequence), [1, 2, 3]);
});

test("one byte at a time still yields whole records", async () => {
  const records = await collect((LINE(1) + LINE(2)).split(""));
  assert.deepEqual(records.map((record) => record.sequence), [1, 2]);
});

test("a malformed line is skipped and reported, the rest survive", async () => {
  const warnings: string[] = [];
  const records = await collect([LINE(1), "{not json\n", LINE(2)], (message) => warnings.push(message));
  assert.deepEqual(records.map((record) => record.sequence), [1, 2]);
  assert.equal(warnings.length, 1);
});

test("a record that is not an event is skipped", async () => {
  const warnings: string[] = [];
  const records = await collect([
    LINE(1),
    `${JSON.stringify({ createdAt: "2026-08-19T00:00:00.000Z", event: {}, sequence: 2 })}\n`,
  ], (message) => warnings.push(message));
  assert.deepEqual(records.map((record) => record.sequence), [1]);
  assert.equal(warnings.length, 1);
});

test("a torn trailing line is dropped rather than parsed", async () => {
  const warnings: string[] = [];
  const records = await collect([LINE(1), '{"sequence":2,"createdAt":'], (message) => warnings.push(message));
  assert.deepEqual(records.map((record) => record.sequence), [1]);
  assert.match(warnings[0] ?? "", /torn trailing line/);
});

test("a keep-alive keeps the socket warm without becoming a record", async () => {
  // One expansion is minutes of silence on a real model, and the client's HTTP
  // stack cannot tell that apart from a dead sidecar — undici's body timeout is
  // 300 seconds. The sidecar sends a bare newline; this is the half that has to
  // ignore it, so the log holds exactly what the engine produced.
  const records: EvolveEventRecord[] = [];
  const warnings: string[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode("\n\n"));
      controller.enqueue(encoder.encode(`${JSON.stringify({
        createdAt: "2026-08-20T00:00:00.000Z",
        event: { algorithm: "puct", scorecardHash: "h", type: "search_started" },
        sequence: 1,
      })}\n`));
      controller.enqueue(encoder.encode("\n"));
      controller.close();
    },
  });

  for await (const record of parseNdjsonStream(stream, (message) => warnings.push(message))) {
    records.push(record);
  }

  assert.equal(records.length, 1);
  assert.equal(records[0]?.sequence, 1);
  // Not even a warning: a blank line is expected traffic, not a malformed one.
  assert.deepEqual(warnings, []);
});

test("a sidecar refusal reaches the user as its sentence, not as a response body", async () => {
  // The one sidecar error a user is expected to read and act on — it stands
  // between them and starting a run. What they saw was
  // `{"detail":{"code":"probe_failed","message":"…"}}` pasted onto the screen,
  // with the sentence buried inside the wrapper.
  const wrapped = new Response(
    JSON.stringify({ detail: { code: "probe_failed", message: "the starting point does not run. It reported: SyntaxError" } }),
    { status: 400 },
  );
  assert.equal(
    await refusal(wrapped, "the discrimination probe could not be taken"),
    "the starting point does not run. It reported: SyntaxError",
  );
});

test("an older handler's bare string detail reads the same way", async () => {
  const bare = new Response(JSON.stringify({ detail: "this scorecard has no criteria" }), { status: 400 });
  assert.equal(
    await refusal(bare, "the discrimination probe could not be taken"),
    "this scorecard has no criteria",
  );
});

test("a body that is not the shape we expect still says something", async () => {
  // A proxy page, a validation array, an empty body: none of them has a
  // sentence to lift, and silence would be worse than the status code.
  const html = new Response("<html>502 Bad Gateway</html>", { status: 502 });
  assert.match(
    await refusal(html, "the discrimination probe could not be taken"),
    /the discrimination probe could not be taken \(502\)/,
  );

  const validation = new Response(JSON.stringify({ detail: [{ loc: ["body"] }] }), { status: 422 });
  assert.match(
    await refusal(validation, "the discrimination probe could not be taken"),
    /the discrimination probe could not be taken \(422\)/,
  );
});
