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
// Multi-shape pipeline stub: the KE stack issues DIFFERENT LLM calls through
// one default model (extraction, community reports, …). This stub picks the
// canned response by matching a marker against the DECODED request body —
// first matching arm wins; the last entry is the fallback.
export interface KeStubArm {
  /** Substring to look for in the decoded request messages. */
  readonly match: string;
  readonly json: unknown;
}

export async function keMultiShapePipelineStub(arms: KeStubArm[]): Promise<KePipelineStub> {
  const model = "ke-journey-multishape-model";
  const apiToken = "ke-journey-multishape-token";
  const fallback = arms[arms.length - 1];
  let server: Server | undefined;
  await new Promise<void>((ready) => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (part: Buffer) => {
        body += part.toString("utf8");
      });
      request.on("end", () => {
        const text = toolResultText(body);
        const arm = arms.find((candidate) => candidate.match !== fallback.match && text.includes(candidate.match)) ?? fallback;
        const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
          `data: ${JSON.stringify({
            choices: [{ delta, finish_reason: finishReason, index: 0 }],
            created: 1,
            id: "chatcmpl-ke-multi",
            model,
            object: "chat.completion.chunk",
          })}\n\n`;
        response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
        response.write(chunk({ content: JSON.stringify(arm.json), role: "assistant" }, null));
        response.write(chunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1", () => ready());
  });
  const address = server!.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("ke multi-shape stub failed to bind");
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
            choices: [{ delta, finishReason, index: 0 }],
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
          response.write(chunk({ content: `根据知识图谱，${entity} 与 Ebola virus glycoprotein 存在 binds 关系。原文证据："${quote}"。`, role: "assistant" }, null));
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

// ---------------------------------------------------------------------------
// Shared body parsing for the result-reading stubs: the runtime sends tool
// results as JSON-encoded STRING content inside the request body's messages,
// so the quotes arrive backslash-escaped in the raw body and regex-over-raw-
// body can never match. Parse the body and run patterns over the decoded
// message content instead.
function toolResultText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    return messages
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
  } catch {
    return body;
  }
}

// ---------------------------------------------------------------------------
// J-KE6 stub: the anti-hallucination chain. Also parses tool results from the
// request history — the final answer is DERIVED from what novelty_check and
// verify_citation actually returned (verdict + citation state), so the
// journey asserts a real dependency, not a canned string.
export interface KeAntiHullucinationStubState {
  getKbId(): string | undefined;
  getNoveltyClaim(): string;
  getQuote(): string;
}

export async function keAntiHallucinationAgentStub(state: KeAntiHullucinationStubState): Promise<KePipelineStub> {
  const model = "ke-journey-antihalluc-model";
  const apiToken = "ke-journey-antihalluc-token";
  let server: Server | undefined;
  let turn = 0;
  await new Promise<void>((ready) => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (part: Buffer) => {
        body += part.toString("utf8");
      });
      request.on("end", () => {
        turn += 1;
        const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
          `data: ${JSON.stringify({
            choices: [{ delta, finishReason, index: 0 }],
            created: 1,
            id: "chatcmpl-ke-antihalluc",
            model,
            object: "chat.completion.chunk",
          })}\n\n`;
        const toolCall = (name: string, args: Record<string, unknown>, id: string) => {
          response.write(chunk({
            role: "assistant",
            tool_calls: [{
              function: { arguments: JSON.stringify(args), name },
              id,
              index: 0,
              type: "function",
            }],
          }, null));
          response.write(chunk({}, "tool_calls"));
        };
        response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
        const kbId = state.getKbId() ?? "";
        if (turn === 1) {
          toolCall("list_knowledge_bases", {}, `call-ke-ah-${turn}`);
        } else if (turn === 2) {
          toolCall("novelty_check", { kbId, claim: state.getNoveltyClaim() }, `call-ke-ah-${turn}`);
        } else if (turn === 3) {
          toolCall("verify_citation", { kbId, quote: state.getQuote() }, `call-ke-ah-${turn}`);
        } else {
          const results = toolResultText(body);
          const verdict = results.match(/"verdict"\s*:\s*"([^"]+)"/)?.[1];
          const citeState = results.match(/"state"\s*:\s*"([^"]+)"/)?.[1];
          if (!verdict || !citeState) {
            response.write(chunk({ content: "反幻觉检查结果未能解析——按规则不给出结论。", role: "assistant" }, null));
          } else {
            const flagged = verdict === "collision"
              ? "novelty_check 报告 collision（库内已有支撑记录），不能声称首次发现。"
              : `novelty_check 报告 ${verdict}（仅指库内，不代表文献全局）。`;
            response.write(chunk({
              content: `${flagged}引文核验：${citeState}。`,
              role: "assistant",
            }, null));
          }
          response.write(chunk({}, "stop"));
        }
        response.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1", () => ready());
  });
  const address = server!.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("ke antihalluc stub failed to bind");
  }
  return {
    apiToken,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model,
    stop: () => new Promise<void>((stopped) => server!.close(() => stopped())),
  };
}
// ---------------------------------------------------------------------------
// J-KE9 stub: the drift_search chain. Reads the drift_search result out of
// the request history and DERIVES the final answer from what the tool
// actually returned (community title, first seed entity, first evidence
// quote) — the journey asserts a real dependency, never a canned string.
export interface KeDriftAgentStubState {
  getKbId(): string | undefined;
  getDriftQuery(): string;
}

export async function keDriftAgentStub(state: KeDriftAgentStubState): Promise<KePipelineStub> {
  const model = "ke-journey-drift-model";
  const apiToken = "ke-journey-drift-token";
  let server: Server | undefined;
  let turn = 0;
  await new Promise<void>((ready) => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (part: Buffer) => {
        body += part.toString("utf8");
      });
      request.on("end", () => {
        turn += 1;
        const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
          `data: ${JSON.stringify({
            choices: [{ delta, finishReason, index: 0 }],
            created: 1,
            id: "chatcmpl-ke-drift",
            model,
            object: "chat.completion.chunk",
          })}\n\n`;
        const toolCall = (name: string, args: Record<string, unknown>, id: string) => {
          response.write(chunk({
            role: "assistant",
            tool_calls: [{
              function: { arguments: JSON.stringify(args), name },
              id,
              index: 0,
              type: "function",
            }],
          }, null));
          response.write(chunk({}, "tool_calls"));
        };
        response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
        const kbId = state.getKbId() ?? "";
        if (turn === 1) {
          toolCall("list_knowledge_bases", {}, `call-ke-drift-${turn}`);
        } else if (turn === 2) {
          toolCall("drift_search", { kbId, query: state.getDriftQuery() }, `call-ke-drift-${turn}`);
        } else {
          const results = toolResultText(body);
          const title = results.match(/"title"\s*:\s*"([^"]+)"/)?.[1];
          const seed = results.match(/"seedEntities"\s*:\s*\[\s*\{\s*[^}]*?"name"\s*:\s*"([^"]+)"/)?.[1];
          const quote = results.match(/"evidenceQuote"\s*:\s*"([^"]+)"/)?.[1];
          if (!title || !seed || !quote) {
            response.write(chunk({
              content: "drift_search 结果未能解析（可能无社区报告或无命中）——按规则不给出主题定位结论。",
              role: "assistant",
            }, null));
          } else {
            response.write(chunk({
              content: `主题定位：该主题位于社区「${title}」，入口实体 ${seed}，逐字证据："${quote}"。`,
              role: "assistant",
            }, null));
          }
          response.write(chunk({}, "stop"));
        }
        response.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1", () => ready());
  });
  const address = server!.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("ke drift stub failed to bind");
  }
  return {
    apiToken,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model,
    stop: () => new Promise<void>((stopped) => server!.close(() => stopped())),
  };
}

// ---------------------------------------------------------------------------
// J-KE5 stub: the kb_search → kb_expand chain. Like the anti-hallucination
// stub it READS the request body — the runtime sends the full message
// history (tool results included), so turn 3 can lift the real anchorId the
// kb_search call produced and expand it, and the final answer can cite it.
export interface KeSearchAgentStubState {
  getKbId(): string | undefined;
  getSearchQuery(): string;
}

export async function keSearchAgentStub(state: KeSearchAgentStubState): Promise<KePipelineStub> {
  const model = "ke-journey-search-model";
  const apiToken = "ke-journey-search-token";
  let server: Server | undefined;
  let turn = 0;
  await new Promise<void>((ready) => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (part: Buffer) => {
        body += part.toString("utf8");
      });
      request.on("end", () => {
        turn += 1;
        const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
          `data: ${JSON.stringify({
            choices: [{ delta, finishReason, index: 0 }],
            created: 1,
            id: "chatcmpl-ke-search",
            model,
            object: "chat.completion.chunk",
          })}\n\n`;
        const toolCall = (name: string, args: Record<string, unknown>, id: string) => {
          response.write(chunk({
            role: "assistant",
            tool_calls: [{
              function: { arguments: JSON.stringify(args), name },
              id,
              index: 0,
              type: "function",
            }],
          }, null));
          response.write(chunk({}, "tool_calls"));
        };
        response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
        const kbId = state.getKbId() ?? "";
        if (turn === 1) {
          toolCall("list_knowledge_bases", {}, `call-ke-search-${turn}`);
        } else if (turn === 2) {
          toolCall("kb_search", { kbId, query: state.getSearchQuery() }, `call-ke-search-${turn}`);
        } else {
          // The kb_search result is in the history this turn — lift the first
          // anchorId out of the DECODED tool content (no fabricated anchors).
          const anchor = toolResultText(body).match(/"anchorId"\s*:\s*"([^"]+)"/)?.[1];
          if (turn === 3 && anchor) {
            toolCall("kb_expand", { kbId, anchorId: anchor }, `call-ke-search-${turn}`);
          } else {
            const cited = anchor ?? "（未命中）";
            response.write(chunk({
              content: `库内文献检索：关于 ${state.getSearchQuery()}，kb_search 命中段落并已展开原文（锚点 ${cited}），证据段落包含目标术语。`,
              role: "assistant",
            }, null));
            response.write(chunk({}, "stop"));
          }
        }
        response.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1", () => ready());
  });
  const address = server!.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("ke search stub failed to bind");
  }
  return {
    apiToken,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model,
    stop: () => new Promise<void>((stopped) => server!.close(() => stopped())),
  };
}
