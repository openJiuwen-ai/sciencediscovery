//!/usr/bin/env bash
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

/**
 * A scripted OpenAI-compatible chat-completions endpoint for L2 scenarios.
 *
 * steps.main and steps.subagent are lists consumed one per model request that
 * offers tools (a request without tools is a title/summary call and gets a fixed
 * reply). Requests are told apart by the product's subagent preset marker in the
 * system prompt, as the journeys' stub does. A step is one of:
 *   { text: "..." }                       stream that text
 *   { tool: "run_shell", arguments: {} }  stream one tool call
 *   { tools: [{ tool, arguments }, ...] }   stream several tool calls in one response (parallel calls)
 *   { fail: 429 }                         answer with that HTTP status
 * and may carry delayMs (wait before answering).
 */

import { createServer } from "node:http";

const SUBAGENT_MARKER = "Applied subagent preset general-purpose";

const chunk = (id, delta, finish = null) => ({
  choices: [{ delta, finish_reason: finish, index: 0 }], created: 1, id, model: "contract-stub", object: "chat.completion.chunk",
});

/** One scripted answer as Anthropic Messages server-sent events. */
function answerAnthropic(sse, id, { text, calls = [] }, outputTokens) {
  sse("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", content: [], model: "contract-stub", usage: { input_tokens: outputTokens ? 20 : 10, output_tokens: 0 } } });
  let index = 0;
  if (text) {
    sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
    for (const word of String(text).split(/(?<= )/)) sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: word } });
    sse("content_block_stop", { type: "content_block_stop", index });
    index += 1;
  }
  for (const call of calls) {
    sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } });
    sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) } });
    sse("content_block_stop", { type: "content_block_stop", index });
    index += 1;
  }
  sse("message_delta", { type: "message_delta", delta: { stop_reason: calls.length ? "tool_use" : "end_turn" }, usage: { output_tokens: outputTokens || 3 } });
  sse("message_stop", { type: "message_stop" });
}

/** One scripted answer as OpenAI Responses server-sent events. */
function answerResponses(sse, id, { text, calls = [] }, outputTokens) {
  sse("response.created", { type: "response.created", response: { id, status: "in_progress" } });
  let outputIndex = 0;
  if (text) {
    for (const word of String(text).split(/(?<= )/)) sse("response.output_text.delta", { type: "response.output_text.delta", output_index: outputIndex, delta: word });
    sse("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item: { type: "message", id: `msg-${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] } });
    outputIndex += 1;
  }
  for (const call of calls) {
    sse("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item: { type: "function_call", id: `fc-${call.id}`, call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments), status: "completed" } });
    outputIndex += 1;
  }
  const output = outputTokens || 3;
  sse("response.completed", { type: "response.completed", response: { id, status: "completed", usage: { input_tokens: outputTokens ? 20 : 10, output_tokens: output, total_tokens: (outputTokens ? 20 : 10) + output } } });
}

export async function startStubModel(steps = {}) {
  const queues = { main: [...(steps.main ?? [])], subagent: [...(steps.subagent ?? [])] };
  const requests = [];
  const consumed = { main: 0, subagent: 0 };
  let lastMessages = [];
  const server = createServer((request, response) => {
    if (request.method === "GET" && /\/models$/.test(request.url ?? "")) {
      // Provider model discovery.
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "contract-stub", object: "model" }, { id: "contract-stub-2", object: "model" }], object: "list" }));
      return;
    }
    const chunks = [];
    request.on("data", (part) => chunks.push(part));
    request.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const id = `chatcmpl-contract-${requests.length + 1}`;
      const protocol = /\/messages$/.test(request.url ?? "") ? "anthropic" : /\/responses$/.test(request.url ?? "") ? "responses" : "openai";
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      const finish = () => response.end("data: [DONE]\n\n");
      const sse = (event, payload) => response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      if (!body.tools?.length) {
        // A title or summary call: fixed reply, does not consume a scripted step.
        requests.push({ route: "title" });
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        if (protocol === "anthropic") answerAnthropic(sse, id, { text: "Contract session" }, 0);
        else if (protocol === "responses") answerResponses(sse, id, { text: "Contract session" }, 0);
        else {
          send(chunk(id, { role: "assistant", content: "Contract session" }));
          send({ ...chunk(id, {}, "stop"), usage: { completion_tokens: 3, prompt_tokens: 10, total_tokens: 13 } });
          finish();
          return;
        }
        response.end();
        return;
      }
      const systemOf = () => {
        if (protocol === "anthropic") return typeof body.system === "string" ? body.system : (body.system ?? []).map((block) => block.text ?? "").join("");
        if (protocol === "responses") return String(body.instructions ?? "");
        return String(body.messages?.find((message) => message.role === "system")?.content ?? "");
      };
      const system = systemOf();
      // A subagent is told apart by the product's preset marker in its system prompt, or by `steps.subagentMarker`
      // anywhere in its messages (a JiuwenSwarm subagent gets the task text the parent gave it).
      const marker = steps.subagentMarker;
      const route = system.includes(SUBAGENT_MARKER) || (marker && JSON.stringify(body.messages ?? body.input ?? []).includes(marker)
        && !/"name":"(subagent_spawn|task_tool)"/.test(JSON.stringify(body.messages ?? []))) ? "subagent" : "main";
      lastMessages = body.messages ?? body.input ?? [];
      const step = queues[route].shift();
      if (step) consumed[route] += 1;
      requests.push({ route, step, system: system.slice(0, 300), systemLength: system.length, messages: (body.messages ?? []).length,
        toolNames: (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name).filter(Boolean) });
      if (!step) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `no scripted ${route} step left` } }));
        return;
      }
      if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      // A step may compute its arguments from the request (an id an earlier tool returned).
      if (typeof step.arguments === "function") step.arguments = step.arguments(body);
      if (step.fail) {
        response.writeHead(step.fail, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `scripted failure ${step.fail}` } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (protocol !== "openai") {
        const calls = step.tools ?? (step.tool ? [{ tool: step.tool, arguments: step.arguments }] : []);
        (protocol === "anthropic" ? answerAnthropic : answerResponses)(sse, id, { text: step.text, calls: calls.map((call, index) => ({ id: `call-${route}-${consumed[route]}-${index + 1}`, name: call.tool, arguments: call.arguments ?? {} })) }, 8);
        response.end();
        return;
      }
      if (step.tools) {
        send(chunk(id, { role: "assistant", tool_calls: step.tools.map((call, index) => ({
          index, id: `call-${route}-${consumed[route]}-${index + 1}`, type: "function",
          function: { name: call.tool, arguments: JSON.stringify(call.arguments ?? {}) },
        })) }));
        send({ ...chunk(id, {}, "tool_calls"), usage: { completion_tokens: 8, prompt_tokens: 20, total_tokens: 28 } });
      } else if (step.tool) {
        send(chunk(id, { role: "assistant", tool_calls: [{ index: 0, id: `call-${route}-${consumed[route]}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.arguments ?? {}) } }] }));
        send({ ...chunk(id, {}, "tool_calls"), usage: { completion_tokens: 8, prompt_tokens: 20, total_tokens: 28 } });
      } else {
        // `reasoning` streams first as reasoning_content; `chunkDelayMs` spaces the words out, as a slow model does.
        const pause = () => step.chunkDelayMs ? new Promise((resolve) => setTimeout(resolve, step.chunkDelayMs)) : undefined;
        for (const word of String(step.reasoning ?? "").split(/(?<= )/).filter(Boolean)) { await pause(); send(chunk(id, { role: "assistant", reasoning_content: word })); }
        for (const word of String(step.text ?? "").split(/(?<= )/)) { await pause(); send(chunk(id, { role: "assistant", content: word })); }
        send({ ...chunk(id, {}, "stop"), usage: { completion_tokens: 8, prompt_tokens: 20, total_tokens: 28 } });
      }
      finish();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: "contract-stub",
    apiToken: "contract-stub-token",
    requests,
    lastMessages: () => lastMessages,
    remaining: () => ({ main: queues.main.length, subagent: queues.subagent.length }),
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}
