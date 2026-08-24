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
 * Agent-loop smoke (hermetic): prove the Node-native loop end-to-end without
 * the full API stack or a live model.
 *
 * A local OpenAI-compatible SSE stub scripts two model turns (one tool call,
 * then a final answer), so the run under test exercises the REAL transport:
 *   native loop -> streaming /chat/completions -> tool-call assembly ->
 *   createWorkspaceTools handler -> tool result into history -> next turn ->
 *   AgentEvents + final wire-format transcript.
 * It also verifies the request payload (system prompt, dynamic tool specs,
 * usage option) and that `finalMessages` round-trips into a second agent run —
 * the mechanism behind the review-correction turn.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import type { AgentEvent } from "@sciencediscovery/orchestration";

import { createNativeAgent } from "../../services/api/src/native-agent/index.js";

interface ChatRequest {
  messages: Array<Record<string, unknown>>;
  model: string;
  stream: boolean;
  tools?: Array<{ function: { description: string; name: string; parameters: Record<string, unknown> }; type: string }>;
}

function sse(response: ServerResponse, frames: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

/** Scripted OpenAI-compatible endpoint; records every request payload. */
function startModelStub(requests: ChatRequest[]): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw) as ChatRequest;
      requests.push(body);
      const lastMessage = body.messages.at(-1) ?? {};
      if (lastMessage.role !== "tool") {
        // First turn of a run: stream some text then call list_files.
        sse(response, [
          { choices: [{ delta: { content: "Checking the workspace…" } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "list_files", arguments: '{"path"' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"."}' } }] } }] },
          { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
        ]);
        return;
      }
      sse(response, [
        { choices: [{ delta: { content: "Listed the workspace files." } }] },
        { choices: [], usage: { prompt_tokens: 42, completion_tokens: 6, total_tokens: 48 } },
      ]);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Smoke assertion failed: ${message}`);
}

async function main(): Promise<void> {
  const requests: ChatRequest[] = [];
  const { server, url } = await startModelStub(requests);
  const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-loop-smoke-"));
  await writeFile(join(workspaceRoot, "notes.md"), "hello");

  const baseOptions = {
    config: { baseUrl: url, apiToken: "stub-token", dataDir: workspaceRoot, model: "stub-model" },
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("run_python must not execute in this smoke"); },
    executeShell: async () => { throw new Error("run_shell must not execute in this smoke"); },
    sessionId: "smoke-session",
    workspaceRoot,
  };

  // ── Run 1: tool round trip + payload shape + events ──
  const events: AgentEvent[] = [];
  const agent = createNativeAgent(baseOptions as Parameters<typeof createNativeAgent>[0]);
  agent.subscribe((event) => events.push(event));
  const first = await agent.execute("What files are in the workspace?");

  assert(requests.length === 2, `model stub saw ${requests.length} requests, expected 2`);
  const firstRequest = requests[0]!;
  assert(firstRequest.model === "stub-model", "per-session model was not sent");
  assert(firstRequest.messages[0]!.role === "system", "system prompt missing");
  assert(String(firstRequest.messages[0]!.content).includes("workspace"), "workspace system prompt missing");
  const toolNames = (firstRequest.tools ?? []).map((tool) => tool.function.name);
  assert(toolNames.includes("list_files") && toolNames.includes("run_python"), `dynamic tool specs missing: ${toolNames.join(",")}`);

  const textDeltas = events.filter((event) => event.type === "message_update").length;
  assert(textDeltas >= 2, "streamed text deltas missing");
  const toolStart = events.find((event) => event.type === "tool_execution_start");
  assert(toolStart && toolStart.type === "tool_execution_start" && toolStart.toolName === "list_files", "tool_execution_start missing");
  const toolEnd = events.find((event) => event.type === "tool_execution_end");
  assert(toolEnd && toolEnd.type === "tool_execution_end" && !toolEnd.isError, "tool_execution_end missing");
  const usage = events.find((event) => event.type === "usage");
  assert(usage && usage.type === "usage" && usage.usage.totalTokens === 48, "usage event missing or wrong");

  const roles = first.finalMessages.map((message) => message.role);
  assert(JSON.stringify(roles) === JSON.stringify(["user", "assistant", "tool", "assistant"]), `unexpected final roles: ${roles.join(",")}`);
  const toolResult = first.finalMessages[2]!;
  assert(String(toolResult.content).includes("notes.md"), "real list_files handler did not run");
  const finalText = String(first.finalMessages.at(-1)?.content ?? "");
  assert(finalText === "Listed the workspace files.", `unexpected final text: ${finalText}`);

  // ── Run 2: canonical history handoff replays the whole first transcript ──
  const second = createNativeAgent({ ...baseOptions, gatewayHistory: first.finalMessages } as Parameters<typeof createNativeAgent>[0]);
  await second.execute("And what did we find?");
  const replayRequest = requests[2]!;
  const replayRoles = replayRequest.messages.map((message) => message.role);
  assert(
    JSON.stringify(replayRoles) === JSON.stringify(["system", "user", "assistant", "tool", "assistant", "user"]),
    `turn-2 replayed roles: ${replayRoles.join(",")}`,
  );

  server.close();
  console.log(
    "Agent loop smoke PASS: native loop + streaming model transport + real tool round-trip + multi-turn history verified.\n"
    + `  final text turn 1: "${finalText}"; turn-2 replayed roles: ${replayRoles.join(",")}`,
  );
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
await once(process, "beforeExit").catch(() => undefined);
