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
import test from "node:test";

import { ApiClient } from "../src/api.js";

test("subscribeRunEvents uses SSE id as the replay sequence", async () => {
  const previousFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode([
        'id: 7',
        'data: {"type":"run.cancelled","reason":"first"}',
        '',
        'id: 9',
        'data: {"type":"run.failed","error":"second"}',
        '',
        '',
      ].join("\n")));
      controller.close();
    },
  });
  globalThis.fetch = async () => new Response(body, { status: 200 });
  try {
    const sequences: number[] = [];
    await new ApiClient("test-token").subscribeRunEvents("session-a", "run-a", 4, (_event, sequence) => {
      sequences.push(sequence);
    });
    assert.deepEqual(sequences, [7, 9]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("cancelRun posts to the run-specific cancel endpoint", async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedMethod = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedMethod = init?.method ?? "GET";
    return Response.json({
      annotationIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "run/1",
      prompt: "queued",
      queueOrder: 2,
      references: [],
      sessionId: "session/a",
      settingsSnapshot: {
        enabledConnectorIds: [],
        enabledSkillIds: [],
        modelId: "model-a",
        semanticReviewEnabled: false,
      },
      status: "cancelled",
    });
  };
  try {
    await new ApiClient("test-token").cancelRun("session/a", "run/1");
    assert.equal(requestedUrl, "/api/sessions/session%2Fa/runs/run%2F1/cancel");
    assert.equal(requestedMethod, "POST");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("listArtifactReviews uses the Session-scoped review endpoint", async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return Response.json([]);
  };
  try {
    assert.deepEqual(await new ApiClient("test-token").listArtifactReviews("session/a"), []);
    assert.equal(requestedUrl, "/api/sessions/session%2Fa/artifact-reviews");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("readProjectArtifactVersion downloads retained content from the Project endpoint", async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response("artifact-content", { headers: { "content-type": "text/plain" } });
  };
  try {
    const blob = await new ApiClient("test-token").readProjectArtifactVersion("project/a", "version/1");
    assert.equal(requestedUrl, "/api/projects/project%2Fa/artifact-versions/version%2F1/content");
    assert.equal(await blob.text(), "artifact-content");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("workspace and artifact image reads keep Bearer auth and forward cancellation", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ headers?: HeadersInit; signal?: AbortSignal | null; url: string }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ headers: init?.headers, signal: init?.signal, url: String(input) });
    return new Response("image", { headers: { "content-type": "image/png" } });
  };
  const controller = new AbortController();
  try {
    const client = new ApiClient("test-token");
    await client.readFile("session/a", "plots/matrix.png", controller.signal);
    await client.readArtifactVersion("session/a", "version/1", controller.signal);
    assert.deepEqual(requests.map((request) => request.url), [
      "/api/sessions/session%2Fa/file?path=plots%2Fmatrix.png",
      "/api/sessions/session%2Fa/artifact-versions/version%2F1/content",
    ]);
    assert.deepEqual(requests.map((request) => request.headers), [
      { authorization: "Bearer test-token" },
      { authorization: "Bearer test-token" },
    ]);
    assert.ok(requests.every((request) => request.signal === controller.signal));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("runReviewerSpecialist posts directly to the Session manual-review endpoint", async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedMethod = "";
  let requestedBody = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedMethod = init?.method ?? "GET";
    requestedBody = String(init?.body);
    return Response.json({
      checkpoint: {
        candidateArtifactVersionIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        id: "checkpoint-1",
        kind: "explicit",
        parentRunId: "manual-review:1",
        reason: "Manual Reviewer Specialist request",
        reviewedArtifactVersionIds: [],
        sessionId: "session/a",
        skippedArtifactVersionIds: [],
        status: "completed",
      },
      message: {
        content: "Reviewer Specialist review",
        createdAt: "2026-01-01T00:00:00.000Z",
        id: "11111111-1111-4111-8111-111111111111",
        kind: "reviewer_checkpoint",
        reviewerCheckpoint: {
          status: "completed",
          toolCallId: "manual-review:11111111-1111-4111-8111-111111111111",
        },
        role: "assistant",
      },
      reviews: [],
    });
  };
  try {
    const messageId = "11111111-1111-4111-8111-111111111111";
    const result = await new ApiClient("test-token").runReviewerSpecialist("session/a", messageId);
    assert.equal(result.checkpoint?.id, "checkpoint-1");
    assert.equal(requestedUrl, "/api/sessions/session%2Fa/reviewer-specialist/review");
    assert.equal(requestedMethod, "POST");
    assert.equal(requestedBody, JSON.stringify({ messageId }));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("updates the Reviewer Specialist system switch and review level", async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedMethod = "";
  let requestedBody = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedMethod = init?.method ?? "GET";
    requestedBody = String(init?.body);
    return Response.json({ enabled: true, level: "deep" });
  };
  try {
    assert.deepEqual(
      await new ApiClient("test-token").updateReviewerSpecialistSettings({ enabled: true, level: "deep" }),
      { enabled: true, level: "deep" },
    );
    assert.equal(requestedUrl, "/api/reviewer-specialist/settings");
    assert.equal(requestedMethod, "PUT");
    assert.equal(requestedBody, JSON.stringify({ enabled: true, level: "deep" }));
  } finally {
    globalThis.fetch = previousFetch;
  }
});
