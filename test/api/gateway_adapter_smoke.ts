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

/**
 * Adapter smoke (hermetic): prove the Node side end-to-end without the full
 * API stack, a model, or ports shared with other tests.
 *
 * A fake in-process gateway speaks the /run contract (verified against the real
 * gateway in test/gateway/run_m0_smoke.sh and run_real_smoke.sh) and performs
 * the same tool callback. The GatewayAgent under test therefore exercises:
 *   adapter -> gateway /run -> tool callback -> createWorkspaceTools handler
 *   -> result back -> NDJSON stream -> AgentEvents.
 * It also verifies the payload (system prompt, dynamic tool specs, per-session
 * model) and that `final_messages` round-trips into a second agent run — the
 * mechanism behind the review-correction turn.
 */
import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import type { AgentEvent } from "@science-agent/agent-runtime";

import { createGatewayAgent, toolCallbackRegistry } from "../../services/api/src/gateway-agent.js";

interface RunBody {
  thread_id: string;
  messages: Array<Record<string, unknown>>;
  system_prompt: string;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  model: { base_url: string; api_key: string; model: string };
  callback_url: string;
  callback_token: string;
}

function writeLine(res: import("node:http").ServerResponse, obj: unknown): void {
  res.write(JSON.stringify(obj) + "\n");
}

/** A fake gateway speaking the Rung C /run contract; records request bodies. */
function startFakeGateway(requests: RunBody[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/run") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = JSON.parse(raw) as RunBody;
      requests.push(body);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      if (requests.length === 1) {
        // Turn 1: model calls list_files, tool round-trips, answer streams.
        writeLine(res, { type: "messages-tuple", data: { type: "ai", id: "ai1", tool_calls: [{ name: "list_files", args: {}, id: "call_1" }] } });
        const cbResponse = await fetch(body.callback_url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${body.callback_token}` },
          body: JSON.stringify({ name: "list_files", args: {}, toolCallId: "call_1" }),
        });
        const cb = (await cbResponse.json()) as { content: string };
        writeLine(res, { type: "messages-tuple", data: { type: "tool", name: "list_files", tool_call_id: "call_1", content: cb.content } });
        writeLine(res, { type: "messages-tuple", data: { type: "ai", id: "ai2", thinking: "checking the listing " } });
        for (const word of ["Listed ", "the ", "workspace ", "files."]) {
          writeLine(res, { type: "messages-tuple", data: { type: "ai", id: "ai2", content: word } });
        }
        writeLine(res, {
          type: "end",
          data: {
            usage: { input_tokens: 8, output_tokens: 8, total_tokens: 16 },
            final_messages: [
              ...body.messages,
              { role: "assistant", content: "", tool_calls: [{ type: "function", id: "call_1", function: { name: "list_files", arguments: "{}" } }] },
              { role: "tool", name: "list_files", tool_call_id: "call_1", content: cb.content },
              { role: "assistant", content: "Listed the workspace files." },
            ],
          },
        });
      } else {
        // Turn 2 (correction-style): text only.
        for (const word of ["No ", "correction ", "needed."]) {
          writeLine(res, { type: "messages-tuple", data: { type: "ai", id: "ai3", content: word } });
        }
        writeLine(res, {
          type: "end",
          data: {
            usage: { input_tokens: 4, output_tokens: 4, total_tokens: 8 },
            final_messages: [...body.messages, { role: "assistant", content: "No correction needed." }],
          },
        });
      }
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => {
    const port = (server.address() as AddressInfo).port;
    return { server, url: `http://127.0.0.1:${port}` };
  });
}

/** Minimal Node callback endpoint backed by the registry (mirrors server.ts). */
function startCallbackServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/internal/tool-exec") {
      res.writeHead(404).end();
      return;
    }
    const token = req.headers.authorization?.replace("Bearer ", "") ?? "";
    const handler = toolCallbackRegistry.get(token);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      if (!handler) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "no handler" }));
        return;
      }
      const body = JSON.parse(raw) as { name: string; args: Record<string, unknown>; toolCallId: string | null };
      const result = await handler(body.name, body.args ?? {}, body.toolCallId ?? null);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ content: result.content, is_error: result.isError }));
    });
  });
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => {
    const port = (server.address() as AddressInfo).port;
    return { server, url: `http://127.0.0.1:${port}/internal/tool-exec` };
  });
}

async function main(): Promise<void> {
  const requests: RunBody[] = [];
  const gateway = await startFakeGateway(requests);
  const callback = await startCallbackServer();

  const workspaceRoot = await mkdtemp(join(tmpdir(), "sa-m2-"));
  await writeFile(join(workspaceRoot, "demo.csv"), "a,b\n1,2\n");

  const notUsed = async () => {
    throw new Error("execution tool should not run in this smoke");
  };
  const baseOptions = {
    sessionId: "sess-m2-smoke",
    gatewayUrl: gateway.url,
    callbackUrl: callback.url,
    config: { apiToken: "test-key", baseUrl: "http://127.0.0.1:9099/v1", dataDir: workspaceRoot, model: "mock-1" },
    enabledConnectorIds: [],
    executePython: notUsed as never,
    executeShell: notUsed as never,
    history: [{ content: "Earlier question", createdAt: new Date().toISOString(), role: "user" as const }],
    skills: [],
    workspaceRoot,
  };
  const agent = createGatewayAgent(baseOptions as never);

  const events: AgentEvent[] = [];
  agent.subscribe((event) => events.push(event));
  const firstResult = await agent.execute("List the files in the workspace.");
  const firstTurnEventCount = events.length;
  const correctionAgent = createGatewayAgent({
    ...baseOptions,
    gatewayHistory: firstResult.finalMessages,
  } as never);
  correctionAgent.subscribe((event) => events.push(event));
  await correctionAgent.execute("Address the Reviewer notice now.");
  gateway.server.close();
  callback.server.close();

  const problems: string[] = [];

  // --- Turn 1 request carries the pi-parity payload -------------------------
  const first = requests[0]!;
  if (!first.system_prompt.includes("local science analysis agent")) problems.push("system_prompt missing workspace prompt");
  const listFilesSpec = first.tools.find((tool) => tool.name === "list_files");
  if (!listFilesSpec || (listFilesSpec.input_schema as { type?: string }).type !== "object") {
    problems.push("tools spec missing list_files with a JSON schema");
  }
  if (!first.tools.some((tool) => tool.name === "run_python")) problems.push("tools spec missing run_python");
  if (first.model.base_url !== "http://127.0.0.1:9099/v1" || first.model.model !== "mock-1" || first.model.api_key !== "test-key") {
    problems.push(`model spec wrong: ${JSON.stringify(first.model)}`);
  }
  const firstRoles = first.messages.map((message) => message.role);
  if (firstRoles.join(",") !== "user,user") problems.push(`turn-1 history wrong: ${firstRoles.join(",")}`);

  // --- Turn 1 events translate correctly ------------------------------------
  const toolStart = events.find((e) => e.type === "tool_execution_start") as Extract<AgentEvent, { type: "tool_execution_start" }> | undefined;
  const toolEnd = events.find((e) => e.type === "tool_execution_end") as Extract<AgentEvent, { type: "tool_execution_end" }> | undefined;
  if (toolStart?.toolName !== "list_files") problems.push(`tool_execution_start expected list_files, got ${toolStart?.toolName}`);
  const toolText = JSON.stringify(toolEnd?.result ?? {});
  if (!toolText.includes("demo.csv")) problems.push(`tool result did not include the real workspace listing: ${toolText}`);
  const updates = events.slice(0, firstTurnEventCount).filter((e) => e.type === "message_update") as Array<{ assistantMessageEvent: { type: string; delta?: string } }>;
  const thinking = updates.filter((u) => u.assistantMessageEvent.type === "thinking_delta").map((u) => u.assistantMessageEvent.delta).join("");
  if (!thinking.includes("checking")) problems.push("thinking_delta not emitted");
  const text = updates.filter((u) => u.assistantMessageEvent.type === "text_delta").map((u) => u.assistantMessageEvent.delta ?? "").join("");
  if (!text.includes("Listed the workspace files.")) problems.push(`unexpected streamed text: "${text}"`);

  // --- Turn 2 replays the round-tripped transcript --------------------------
  const second = requests[1]!;
  const secondRoles = second.messages.map((message) => message.role);
  if (secondRoles.join(",") !== "user,user,assistant,tool,assistant,user") {
    problems.push(`turn-2 history did not round-trip final_messages: ${secondRoles.join(",")}`);
  }
  const lastMessage = second.messages.at(-1) as { content?: string };
  if (lastMessage?.content !== "Address the Reviewer notice now.") problems.push("turn-2 user message missing");

  if (problems.length) {
    console.error("Adapter smoke FAIL:\n- " + problems.join("\n- "));
    console.error("events:", JSON.stringify(events.map((e) => e.type)));
    process.exit(1);
  }
  console.log("Adapter smoke PASS: pi-parity payload + stream translation + real tool round-trip + multi-turn history verified.");
  console.log(`  final text turn 1: "${text.trim()}"; turn-2 replayed roles: ${secondRoles.join(",")}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Adapter smoke ERROR:", error);
  process.exit(1);
});
