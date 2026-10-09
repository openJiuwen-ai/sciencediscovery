// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describeImageWithVision } from "./pdf-vision.js";

interface RecordedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** Local HTTP stub speaking either vision protocol; records requests. */
async function visionStub(respond: (body: Record<string, unknown>) => { status: number; payload: unknown }): Promise<{
  baseUrl: string;
  requests: RecordedRequest[];
  stop: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  let server: Server | undefined;
  await new Promise<void>((ready) => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        requests.push({ body, url: request.url ?? "" });
        const { status, payload } = respond(body);
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      });
    });
    server.listen(0, "127.0.0.1", () => ready());
  });
  const address = server!.address();
  if (typeof address !== "object" || address === null) throw new Error("stub failed to bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    stop: () => new Promise<void>((stopped) => server!.close(() => stopped())),
  };
}

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

test("minimax protocol posts prompt+image_url to /coding_plan/vlm", async () => {
  const stub = await visionStub(() => ({ status: 200, payload: { content: "a blot with three bands", base_resp: { status_code: 0, status_msg: "success" } } }));
  try {
    const text = await describeImageWithVision({ apiToken: "t", baseUrl: stub.baseUrl, protocol: "minimax" }, PNG);
    assert.equal(text, "a blot with three bands");
    assert.equal(stub.requests.length, 1);
    assert.ok(stub.requests[0]!.url.endsWith("/coding_plan/vlm"));
    const body = stub.requests[0]!.body as { prompt?: string; image_url?: string };
    assert.match(body.prompt ?? "", /scientific paper/);
    assert.ok(body.image_url?.startsWith("data:image/png;base64,"));
  } finally {
    await stub.stop();
  }
});

test("minimax protocol surfaces base_resp errors", async () => {
  const stub = await visionStub(() => ({ status: 200, payload: { base_resp: { status_code: 1002, status_msg: "rate limited" } } }));
  try {
    await assert.rejects(
      () => describeImageWithVision({ apiToken: "t", baseUrl: stub.baseUrl, protocol: "minimax" }, PNG),
      /1002.*rate limited/,
    );
  } finally {
    await stub.stop();
  }
});

test("openai protocol posts chat completions with image content parts", async () => {
  const stub = await visionStub((body) => {
    const messages = body["messages"] as Array<{ content: Array<{ type: string }> }>;
    assert.equal(messages[0]!.content[1]!.type, "image_url");
    return { status: 200, payload: { choices: [{ message: { content: "volcano plot, log2FC axes" } }] } };
  });
  try {
    const text = await describeImageWithVision({ apiToken: "t", baseUrl: stub.baseUrl, model: "vlm-1" }, PNG);
    assert.equal(text, "volcano plot, log2FC axes");
    assert.ok(stub.requests[0]!.url.endsWith("/chat/completions"));
    assert.equal((stub.requests[0]!.body as { model?: string }).model, "vlm-1");
  } finally {
    await stub.stop();
  }
});

test("openai protocol requires a model id", async () => {
  await assert.rejects(
    () => describeImageWithVision({ apiToken: "t", baseUrl: "http://127.0.0.1:1" }, PNG),
    /requires a model id/,
  );
});

test("http errors throw with status", async () => {
  const stub = await visionStub(() => ({ status: 500, payload: { error: "boom" } }));
  try {
    await assert.rejects(
      () => describeImageWithVision({ apiToken: "t", baseUrl: stub.baseUrl, protocol: "minimax" }, PNG),
      /HTTP 500/,
    );
  } finally {
    await stub.stop();
  }
});
