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

// QA-owned stub for knowledge-engine pipeline LLM calls (mocked journeys).
//
// scriptedModel in helpers/journeys.ts is built for agent tool-calling turns:
// requests WITHOUT tools — exactly the shape of the KE extraction pipeline
// (streamModelTurn with an empty tool list) — get a canned "Journey session"
// text and never consult the script. This stub instead answers EVERY
// chat-completions request with the same fixed payload, mirroring the SSE
// chunk format scriptedModel produces (choices[0].delta + finish_reason +
// "data: [DONE]"), so the pipeline's salvageJson sees valid JSON every call.

import { createServer, type Server } from "node:http";

export interface KePipelineStub {
  readonly baseUrl: string;
  readonly apiToken: string;
  readonly model: string;
  stop(): Promise<void>;
}

/** Serve `responseJson` as the assistant text for every chat-completions call. */
export async function kePipelineStub(responseJson: unknown): Promise<KePipelineStub> {
  const model = "ke-journey-stub-model";
  const apiToken = "ke-journey-stub-token";
  const text = JSON.stringify(responseJson);
  let server: Server | undefined;
  await new Promise<void>((ready) => {
    server = createServer((request, response) => {
      request.on("data", () => undefined);
      request.on("end", () => {
        const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
          `data: ${JSON.stringify({
            choices: [{ delta, finish_reason: finishReason, index: 0 }],
            created: 1,
            id: "chatcmpl-ke-stub",
            model,
            object: "chat.completion.chunk",
          })}\n\n`;
        response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
        response.write(chunk({ content: text, role: "assistant" }, null));
        response.write(chunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1", () => ready());
  });
  const address = server!.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("ke stub failed to bind");
  }
  return {
    apiToken,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model,
    stop: () => new Promise<void>((stopped) => server!.close(() => stopped())),
  };
}

// ---------------------------------------------------------------------------
// Agent-session stub with a dynamic kbId: scriptedModel scripts are static,
// but the KE tools require the runtime-created kbId. This stub reads the id
// (and the discovered entity name) through getters at request time.
// Turn sequence per conversation: 1) list_knowledge_bases, 2) concept_explore,
// 3) final text answer quoting the evidence.
export interface KeAgentStubState {
  getKbId(): string | undefined;
  getEntityName(): string | undefined;
  getEvidenceQuote(): string | undefined;
}

export interface KeAgentStub extends KePipelineStub {
  readonly state: KeAgentStubState;
}

export async function keAgentStub(state: KeAgentStubState): Promise<KeAgentStub> {
  const model = "ke-journey-agent-model";
  const apiToken = "ke-journey-agent-token";
  let server: Server | undefined;
  let turn = 0;
  await new Promise<void>((ready) => {
    server = createServer((request, response) => {
      request.on("data", () => undefined);
      request.on("end", () => {
        turn += 1;
        const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
          `data: ${JSON.stringify({
            choices: [{ delta, finish_reason: finishReason, index: 0 }],
            created: 1,
            id: "chatcmpl-ke-agent",
            model,
            object: "chat.completion.chunk",
          })}\n\n`;
        response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
        if (turn === 1) {
          response.write(chunk({
            role: "assistant",
            tool_calls: [{
              function: { arguments: "{}", name: "list_knowledge_bases" },
              id: `call-ke-agent-${turn}`,
              index: 0,
              type: "function",
            }],
          }, null));
          response.write(chunk({}, "tool_calls"));
        } else if (turn === 2) {
          const kbId = state.getKbId() ?? "";
          response.write(chunk({
            role: "assistant",
            tool_calls: [{
              function: { arguments: JSON.stringify({ kbId, hops: 1, limit: 20 }), name: "concept_explore" },
              id: `call-ke-agent-${turn}`,
              index: 0,
              type: "function",
            }],
          }, null));
          response.write(chunk({}, "tool_calls"));
        } else {
          const entity = state.getEntityName() ?? "mAb114";
          const quote = state.getEvidenceQuote() ?? "";
          response.write(chunk({ content: `根据知识图谱，${entity} 与 Ebola virus glycoprotein 存在 binds 关系。原文证据：“${quote}”。`, role: "assistant" }, null));
          response.write(chunk({}, "stop"));
        }
        response.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1", () => ready());
  });
  const address = server!.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("ke agent stub failed to bind");
  }
  return {
    apiToken,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model,
    state,
    stop: () => new Promise<void>((stopped) => server!.close(() => stopped())),
  };
}
