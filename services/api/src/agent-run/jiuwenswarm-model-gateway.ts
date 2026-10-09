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

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { recordingStage, waitForRecording } from "./recording-wait.js";
import { recordInvalidArguments } from "./model-argument-diagnostics.js";

import {
  ModelRequestError,
  streamModelTurn,
  type ModelClientPolicy,
  type ModelEndpoint,
  type ModelTurn,
  type WireToolSpec,
} from "@sciencediscovery/model";

/**
 * The model, as JiuwenSwarm sees it: an OpenAI chat-completions endpoint on loopback.
 *
 * JiuwenSwarm only speaks OpenAI chat completions to a model, while a ScienceDiscovery model may be
 * Anthropic Messages or OpenAI Responses, with a provider variant (DeepSeek, Gemini, Kimi, Qwen ...),
 * thinking controls, a network proxy and a retry policy. Those already live in the native model
 * client, so a run's model requests are served by it: JiuwenSwarm's request comes in as chat
 * completions, goes out through `streamModelTurn` in the model's own protocol, and the answer (text,
 * thinking, tool calls, usage) goes back as chat completions.
 */
export interface ModelGateway {
  /** Base URL to give JiuwenSwarm, up to and including `/v1`. */
  url: string;
  token: string;
  /**
   * The assistant message the model client produced for a turn, in place of the plain chat-completions
   * copy JiuwenSwarm rebuilt from it. The native message keeps what the provider needs sent back
   * verbatim (Anthropic thinking blocks with their signatures, Responses reasoning items), which
   * a chat-completions message cannot carry. Other messages come back unchanged.
   */
  restore<T extends Record<string, unknown>>(message: T): T;
  /** The last model turn served, for what the run's end has to say about it. */
  lastTurn(): { text: string; toolCalls: number; truncated: boolean; recoveryAttempts?: number } | undefined;
  lastFailure(): { requestId: string; truncated: boolean; tools: string[] } | undefined;
  /** Payload-free metadata for active requests; never includes prompts or arguments. */
  diagnostics(): Array<{ id: string; purpose: "task" | "auxiliary"; phase: string; elapsedMs: number;
    upstreamChunks: number; downstreamChunks: number; upstreamIdleMs: number; downstreamIdleMs: number }>;
  close(): Promise<void>;
}

type Streamer = typeof streamModelTurn;
type HistoryMessage = Parameters<Streamer>[2][number];

interface ChatRequest {
  model?: string;
  messages?: Array<Record<string, unknown>>;
  stream?: boolean;
  tools?: Array<{ function?: { description?: string; name?: string; parameters?: unknown } }>;
}

const readBody = async (request: IncomingMessage): Promise<ChatRequest> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as ChatRequest;
};

/** The text of a message's content, whether it is a string or a list of parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "object" && part !== null && (part as { type?: string }).type === "text"
    ? String((part as { text?: unknown }).text ?? "") : "")).join("");
}

/** True when a message carries anything but text (an image), which the native client cannot send. */
const hasNonText = (message: Record<string, unknown>) =>
  Array.isArray(message.content) && message.content.some((part) => (part as { type?: string })?.type !== "text");

/** What identifies an assistant turn: the tool calls it made, or else its text. */
const turnKey = (message: Record<string, unknown>) => {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls as Array<{ id?: unknown }> : [];
  return calls.length ? `calls:${calls.map((call) => String(call.id)).join(",")}` : `text:${textOf(message.content)}`;
};

export function toModelRequest(body: ChatRequest, restore: ModelGateway["restore"] = (message) => message): { history: HistoryMessage[]; systemPrompt: string; tools: WireToolSpec[] } {
  const messages = body.messages ?? [];
  const systemPrompt = messages.filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n\n");
  const history = messages.filter((message) => message.role !== "system").map((message) => restore({
    ...message,
    ...(Array.isArray(message.content) ? { content: textOf(message.content) } : {}),
  })) as HistoryMessage[];
  const tools = (body.tools ?? []).flatMap((tool) => tool.function?.name
    ? [{ name: tool.function.name, description: tool.function.description ?? "", parameters: tool.function.parameters ?? { type: "object" } }]
    : []);
  return { history, systemPrompt, tools };
}

function usageOf(turn: ModelTurn) {
  const usage = turn.usage;
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens,
    ...(usage.cacheReadTokens ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } } : {}),
  };
}

/** Recording the trajectory must never fail the model call. */
const warnTrajectory = (error: unknown) => {
  console.warn(`[jiuwenswarm] could not record the model call in the trajectory: ${error instanceof Error ? error.message : String(error)}`);
};

const WITHHELD_TOOLS = "[output_limit:tool_calls_withheld] No tools from this response were executed.";
const finishReason = (turn: ModelTurn) => turn.truncated ? "length" : turn.toolCalls.length ? "tool_calls" : "stop";
const toolCallsOf = (turn: ModelTurn) => turn.toolCalls.map((call, index) => ({
  index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) },
}));

/**
 * Told about each task model call of the run (not Swarm housekeeping or compaction):
 * its exact input before it is made, the answer after. The run's trajectory is recorded from these.
 */
export interface ModelCallObserver {
  request(input: { history: unknown[]; systemPrompt: string; tools: WireToolSpec[] }): Promise<void>;
  completed(turn: ModelTurn, history: unknown[]): Promise<void>;
}

/** Run control is independent of optional, best-effort trajectory logging. */
export interface ModelGatewayLifecycle {
  progress(): void;
  /** Synchronous admission, before sending a task model request upstream. */
  beforeTurn?(): void;
}

// The pinned Swarm forked compressor retains tool schemas for prefix caching.
// Tool presence cannot distinguish it from task reasoning. Fail closed (count
// the call) if a future compressor changes this explicitly recognised prompt.
export function isSwarmCompaction(body: ChatRequest): boolean {
  const last = body.messages?.at(-1);
  const content = last?.content;
  return last?.role === "user" && typeof content === "string"
    && content.startsWith("## NON-NEGOTIABLE OUTPUT RULES")
    && content.includes("Do NOT call any tools.")
    && content.includes("You are an Execution State Compression Assistant.")
    && content.includes("<coverage_check>") && content.includes("<state_snapshot>");
}

export async function startModelGateway(
  endpoint: ModelEndpoint,
  policy: ModelClientPolicy,
  signal: AbortSignal,
  streamer: Streamer = streamModelTurn,
  observer?: ModelCallObserver,
  lifecycle?: ModelGatewayLifecycle,
): Promise<ModelGateway> {
  const token = randomUUID();
  const produced = new Map<string, Record<string, unknown>>();
  let last: ReturnType<ModelGateway["lastTurn"]>;
  let lastFailure: ReturnType<ModelGateway["lastFailure"]>;
  const active = new Map<string, () => ReturnType<ModelGateway["diagnostics"]>[number]>();
  const remember = (turn: ModelTurn, body: ChatRequest) => {
    produced.set(turnKey(turn.assistantMessage), turn.assistantMessage);
    const latest = body.messages?.at(-1);
    const recovery = latest?.role === "user" && typeof latest.content === "string"
      ? latest.content.match(/^\[Output limit recovery ([12])\/2;/) : null;
    last = { text: textOf(turn.assistantMessage.content), toolCalls: turn.toolCalls.length,
      truncated: turn.truncated === true, ...(recovery ? { recoveryAttempts: Number(recovery[1]) } : {}) };
    if (turn.truncated) console.warn(`[output-recovery] ${JSON.stringify({ event: "model.output_limit",
      kind: turn.toolCalls.length ? "tool_arguments" : last.text.trim() ? "partial_answer" : "reasoning_only",
      maxTokens: policy.maxTokens, recoveryAttempts: last.recoveryAttempts ?? 0,
      withheldToolCount: turn.toolCalls.length, usage: turn.usage })}`);
  };
  const restore: ModelGateway["restore"] = (message) => {
    const own = message.role === "assistant" ? produced.get(turnKey(message)) : undefined;
    return (own ?? message) as typeof message;
  };
  const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const fail = (status: number, message: string) => {
      if (!response.headersSent) response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message, type: "model_gateway_error" } }));
    };
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions") || request.headers.authorization !== `Bearer ${token}`) {
      fail(request.headers.authorization === `Bearer ${token}` ? 404 : 401, "unauthorized");
      return;
    }
    let body: ChatRequest;
    try {
      body = await readBody(request);
    } catch {
      fail(400, "invalid JSON");
      return;
    }
    // JiuwenSwarm probes a model for image input with a picture; a text-only client answers "no".
    if ((body.messages ?? []).some(hasNonText)) {
      fail(400, "images are not supported by this gateway");
      return;
    }
    const { history, systemPrompt, tools } = toModelRequest(body, restore);
    const housekeeping = request.headers["x-sciencediscovery-model-purpose"] === "housekeeping";
    const auxiliary = housekeeping || isSwarmCompaction(body);
    // The legacy default-model route selects the latest active endpoint, not
    // necessarily the owner of its housekeeping work. It cannot renew a run.
    const progress = () => { if (!housekeeping) lifecycle?.progress(); };
    const observed = auxiliary ? undefined : observer;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    response.on("close", () => { if (!response.writableEnded) controller.abort(); });
    const id = `chatcmpl-${randomUUID()}`;
    if (!auxiliary) lastFailure = undefined;
    const rejectInvalidArguments = (turn: ModelTurn) => {
      // Truncated calls are withheld and returned to Swarm for bounded recovery.
      if (turn.truncated) return;
      const invalid = turn.toolCalls.filter(call => call.argsParseError);
      if (!invalid.length) return;
      if (!auxiliary) lastFailure = { requestId: id, truncated: false,
        tools: invalid.map(call => call.name).slice(0, 20) };
      throw new Error("Model returned invalid tool arguments");
    };
    const streamStarted = Date.now();
    let upstreamChunks = 0, downstreamChunks = 0, toolArgumentChars = 0;
    let lastUpstreamAt = streamStarted, lastDownstreamAt = streamStarted, lastLogAt = 0;
    let phase = "preparing";
    active.set(id, () => ({ id, purpose: auxiliary ? "auxiliary" : "task", phase,
      elapsedMs: Date.now() - streamStarted, upstreamChunks, downstreamChunks,
      upstreamIdleMs: Date.now() - lastUpstreamAt, downstreamIdleMs: Date.now() - lastDownstreamAt }));
    const upstream = () => { phase = "receiving"; progress(); upstreamChunks++; lastUpstreamAt = Date.now(); };
    const trace = (event: string, force = false) => {
      const now = Date.now();
      if (process.env.SCIENCE_AGENT_TRACE_MODEL_STREAM !== "1" || (!force && now - lastLogAt < 5_000)) return;
      lastLogAt = now;
      console.info(`[model-stream] ${JSON.stringify({ id, requestModel: body.model, phase: event,
        elapsedMs: now - streamStarted, upstreamChunks, downstreamChunks, toolArgumentChars,
        upstreamIdleMs: now - lastUpstreamAt, downstreamIdleMs: now - lastDownstreamAt })}`);
    };
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: endpoint.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const observe = async (stage: "input" | "completion", operation: () => Promise<void>) => {
      controller.signal.throwIfAborted();
      phase = `recording_${stage}`;
      const work = recordingStage(phase, { requestId: id }, operation, controller.signal).catch(warnTrajectory);
      await waitForRecording(work, controller.signal);
      controller.signal.throwIfAborted();
    };
    const prepare = async () => {
      if (observed) await observe("input", () => observed.request({ history, systemPrompt, tools }));
      controller.signal.throwIfAborted();
      phase = "upstream_dispatched";
      trace("upstream_dispatched", true);
    };
    const record = async (turn: ModelTurn) => {
      if (observed) await observe("completion", () => observed.completed(turn, history));
    };
    try {
      controller.signal.throwIfAborted();
      if (!auxiliary) { last = undefined; lifecycle?.beforeTurn?.(); }
      // Admission listeners can abort the run when its turn budget is spent.
      signal.throwIfAborted();
      if (body.stream) {
        // Headers wait for the first byte of the answer so that a refused request is a real HTTP error.
        let started = false;
        const start = () => {
          if (started) return;
          started = true;
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          response.write(chunk({ role: "assistant" }));
        };
        const writeDelta = (delta: Record<string, unknown>) => {
          controller.signal.throwIfAborted();
          progress();
          start();
          response.write(chunk(delta));
          downstreamChunks++;
          lastDownstreamAt = Date.now();
          trace("forward");
        };
        trace("start", true);
        await prepare();
        controller.signal.throwIfAborted();
        const turn = await streamer(endpoint, systemPrompt, history, tools, policy, controller.signal, {
          onProgress: () => { upstream(); trace("receive"); },
          onTextDelta: (delta) => writeDelta({ content: delta }),
          onThinkingDelta: (delta) => writeDelta({ reasoning_content: delta }),
          onToolCallDelta: (delta) => {
            // Keep tool arguments behind the finish boundary: even valid JSON
            // can be semantically incomplete when the response hits its cap.
            controller.signal.throwIfAborted();
            toolArgumentChars += delta.arguments.length;
            // SSE comments are discarded by OpenAI SDKs and never reach Swarm's
            // decoded-chunk idle watchdog. An empty delta carries real upstream
            // progress without exposing partial arguments or adding model text.
            writeDelta({});
          },
        });
        controller.signal.throwIfAborted();
        await recordInvalidArguments(turn, id);
        rejectInvalidArguments(turn);
        start();
        if (!auxiliary) remember(turn, body);
        if (turn.truncated) {
          if (turn.toolCalls.length) writeDelta({ content: WITHHELD_TOOLS });
        } else {
          for (const call of toolCallsOf(turn)) writeDelta({ tool_calls: [call] });
        }
        await record(turn);
        const usage = usageOf(turn);
        response.write(chunk({}, finishReason(turn), usage ? { usage } : {}));
        response.end("data: [DONE]\n\n");
        trace("complete", true);
        return;
      }
      await prepare();
      controller.signal.throwIfAborted();
      const turn = await streamer(endpoint, systemPrompt, history, tools, policy, controller.signal, {
        onProgress: upstream,
        onTextDelta: progress,
        onThinkingDelta: progress,
        onToolCallDelta: progress,
      });
      controller.signal.throwIfAborted();
      await recordInvalidArguments(turn, id);
      rejectInvalidArguments(turn);
      if (!auxiliary) remember(turn, body);
      await record(turn);
      const content = typeof turn.assistantMessage.content === "string" ? turn.assistantMessage.content : textOf(turn.assistantMessage.content);
      const usage = usageOf(turn);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: endpoint.model,
        choices: [{ index: 0, finish_reason: finishReason(turn), message: { role: "assistant", content: content + (turn.truncated && turn.toolCalls.length ? WITHHELD_TOOLS : ""), ...(!turn.truncated && turn.toolCalls.length ? { tool_calls: toolCallsOf(turn).map(({ index: _index, ...call }) => call) } : {}) } }],
        ...(usage ? { usage } : {}),
      }));
    } catch (error) {
      trace(controller.signal.aborted ? "cancelled" : "error", true);
      const status = error instanceof ModelRequestError && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502;
      const message = error instanceof Error ? error.message : String(error);
      if (response.headersSent) {
        // Mid-stream: tell the client the way OpenAI does, then stop.
        response.write(`data: ${JSON.stringify({ error: { message, type: "model_gateway_error" } })}\n\n`);
        response.end();
      } else {
        fail(status, message);
      }
    } finally {
      active.delete(id);
      signal.removeEventListener("abort", abort);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    token,
    restore,
    lastTurn: () => last,
    lastFailure: () => lastFailure,
    diagnostics: () => [...active.values()].map(snapshot => snapshot()),
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
