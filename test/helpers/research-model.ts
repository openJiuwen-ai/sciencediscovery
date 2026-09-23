// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

type Message = { role?: string; content?: unknown; tool_calls?: Array<{ id?: string }> };
export type ResearchStep = {
  text?: string;
  tools?: Array<{ name: string; arguments: Record<string, unknown>; rawArguments?: string }>;
  /** Hold a response until the test releases this gate; no timing-based child ordering. */
  gate?: string;
  disconnect?: boolean;
  /** Expected pre-stream provider failure, without a fixture assertion failure. */
  httpStatus?: 429 | 500 | 503;
};
export type ResearchRequest = { messages: Message[]; results: string[]; route: string; index: number };
export type ResearchScriptStep = ResearchStep | ((request: ResearchRequest) => ResearchStep);

/** Each child is identified by LR_CHILD_<name> in its actual delegated prompt.
 * Progress is derived from tool-call IDs in actual model history, not a shared
 * mutable child counter. Provider retries replay the same response.
 */
export async function researchModel(scripts: Record<string, ResearchScriptStep[]>, options: {
  summary?: (messages: Message[]) => string;
  stepIndex?: (request: ResearchRequest) => number;
} = {}) {
  const calls: Array<{ route: string; step: number; startedAt: number; endedAt?: number;
    aborted?: boolean; tools: string[]; results: string[]; messages: Message[] }> = [];
  const errors: string[] = [];
  const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const gate = (name: string) => {
    if (!gates.has(name)) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      gates.set(name, { promise, resolve });
    }
    return gates.get(name)!;
  };
  const server = createServer(async (request, response) => {
    let cancelled = false;
    let abortWait!: () => void;
    const closed = new Promise<void>((done) => { abortWait = done; });
    response.once("close", () => { cancelled = !response.writableEnded; abortWait(); });
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        messages?: Message[]; tools?: Array<{ function?: { name?: string } }>;
      };
      const messages = body.messages ?? [];
      const offered = (body.tools ?? []).map(t => t.function?.name ?? "");
      const system = messages.filter(m => m.role === "system").map(m => String(m.content)).join("\n");
      const isChild = system.includes("Applied subagent preset general-purpose");
      const user = messages.filter(m => m.role === "user").map(m => String(m.content)).join("\n");
      // Swarm's forked compressor intentionally keeps the main tool schemas
      // for prefix reuse. Identify its final instruction, not tools.length.
      const last = messages.at(-1);
      const isSummary = last?.role === "user" && typeof last.content === "string"
        && last.content.includes("Do NOT call any tools.")
        && last.content.includes("<coverage_check>") && last.content.includes("<state_snapshot>");
      const route = isSummary ? "summary" : !offered.length ? "title" : isChild ? /LR_CHILD_([a-z]+)/.exec(user)?.[1] : "main";
      if (!route) throw new Error("Child request has no delegated identity marker");
      const prefix = `lr_${route}_`;
      const prior = messages.filter(m => m.role === "assistant").flatMap(m => m.tool_calls ?? [])
        .map(t => t.id ?? "").filter(id => id.startsWith(prefix)).map(id => Number(id.slice(prefix.length).split("_")[0]));
      let index = prior.length ? Math.max(...prior) + 1 : 0;
      const results = messages.filter(m => m.role === "tool").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      if (route !== "title" && route !== "summary" && options.stepIndex) index = options.stepIndex({ messages, results, route, index });
      if (route === "summary" && !options.summary) throw new Error("Unexpected compression request without a summary fixture");
      const selected = route === "summary" ? { text: options.summary!(messages) }
        : route === "title" ? { text: options.summary?.(messages) ?? "Local research fixture" } : scripts[route]?.[index];
      const step = typeof selected === "function" ? selected({ messages, results, route, index }) : selected;
      if (!step) throw new Error(`Unexpected model step ${route}:${index}`);
      for (const tool of step.tools ?? []) if (!offered.includes(tool.name)) throw new Error(`Tool not offered: ${route}:${tool.name}`);
      const call = { route, step: index, startedAt: Date.now(), tools: offered, results, messages,
      } as typeof calls[number];
      calls.push(call);
      if (step.httpStatus) {
        response.writeHead(step.httpStatus, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Controlled upstream failure" } }));
        call.endedAt = Date.now();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({
        id: `chatcmpl-lr-${route}-${index}`, object: "chat.completion.chunk", created: 1, model: "research-local-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
      response.write(chunk({ role: "assistant" }));
      if (step.gate) await Promise.race([gate(step.gate).promise, closed]);
      if (cancelled) { call.aborted = true; return; }
      if (step.tools) response.write(chunk({ tool_calls: step.tools.map((tool, i) => ({
        index: i, id: `${prefix}${index}_${i}`, type: "function",
        function: { name: tool.name, arguments: tool.rawArguments ?? JSON.stringify(tool.arguments) },
      })) }));
      if (step.text) response.write(chunk({ content: step.text }));
      if (step.disconnect) { response.destroy(); call.aborted = true; return; }
      response.write(chunk({}, step.tools ? "tool_calls" : "stop"));
      response.end("data: [DONE]\n\n");
      call.endedAt = Date.now();
    } catch (error) {
      errors.push(String(error));
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unexpected fixture request; inspect fixture-errors attachment" }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    model: "research-local-model", apiToken: "local-fixture-not-a-secret", calls, errors,
    release: (name: string) => gate(name).resolve(),
    stop: async () => {
      for (const item of gates.values()) item.resolve();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}
