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
 * A local OpenAI-compatible SSE stub scripts three model turns (activate
 * Direct Mode, call one workspace tool, then answer), so the run under test
 * exercises the REAL transport and the execution-mode visibility contract:
 *   native loop -> activate mode -> dynamic tool exposure -> tool-call
 *   assembly -> createWorkspaceTools handler -> tool result into history ->
 *   next turn -> AgentEvents + final wire-format transcript.
 * It also verifies the request payload (system prompt, dynamic tool specs,
 * usage option) and that `finalMessages` round-trips into a second agent run —
 * the mechanism behind the review-correction turn.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      const toolNames = (body.tools ?? []).map((tool) => tool.function.name);
      const lastMessage = body.messages.at(-1) ?? {};
      const previousAssistant = body.messages.at(-2) as {
        tool_calls?: Array<{ function?: { name?: string } }>;
      } | undefined;
      const lastToolName = previousAssistant?.tool_calls?.[0]?.function?.name;
      if (!toolNames.includes("list_files")) {
        // First turn of every run: select Direct Mode. Mode-specific tools
        // become visible only on the following model turn.
        sse(response, [
          { choices: [{ delta: { content: "Selecting direct execution…" } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-mode", type: "function", function: { name: "activate_execution_mode", arguments: '{"modeId"' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"direct"}' } }] } }] },
          { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
        ]);
        return;
      }
      if (lastMessage.role !== "tool" || lastToolName === "activate_execution_mode") {
        // Direct Mode is active: execute a real workspace tool.
        sse(response, [
          { choices: [{ delta: { content: "Checking the workspace…" } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-list", type: "function", function: { name: "list_files", arguments: '{"path"' } }] } }] },
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
  // A failed assertion must not leave the listening stub keeping CI alive.
  server.unref();
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

  assert(requests.length === 3, `model stub saw ${requests.length} requests, expected 3`);
  const firstRequest = requests[0]!;
  assert(firstRequest.model === "stub-model", "per-session model was not sent");
  assert(firstRequest.messages[0]!.role === "system", "system prompt missing");
  assert(String(firstRequest.messages[0]!.content).includes("workspace"), "workspace system prompt missing");
  const initialToolNames = (firstRequest.tools ?? []).map((tool) => tool.function.name);
  assert(
    JSON.stringify(initialToolNames) === JSON.stringify(["activate_execution_mode"]),
    `initial tool specs should expose only mode activation: ${initialToolNames.join(",")}`,
  );
  const directToolNames = (requests[1]!.tools ?? []).map((tool) => tool.function.name);
  assert(
    directToolNames.includes("list_files") && directToolNames.includes("run_python"),
    `Direct Mode tool specs missing or stale: ${directToolNames.join(",")}`,
  );

  const textDeltas = events.filter((event) => event.type === "message_update").length;
  assert(textDeltas >= 3, "streamed text deltas missing");
  const toolStarts = events.filter((event) => event.type === "tool_execution_start");
  assert(
    toolStarts.some((event) => event.type === "tool_execution_start" && event.toolName === "activate_execution_mode")
      && toolStarts.some((event) => event.type === "tool_execution_start" && event.toolName === "list_files"),
    "mode activation or list_files tool_execution_start missing",
  );
  const listToolEnd = events.find(
    (event) => event.type === "tool_execution_end" && event.toolName === "list_files",
  );
  assert(listToolEnd && listToolEnd.type === "tool_execution_end" && !listToolEnd.isError, "list_files tool_execution_end missing");
  const usage = events.find((event) => event.type === "usage");
  assert(usage && usage.type === "usage" && usage.usage.totalTokens === 48, "usage event missing or wrong");

  const roles = first.finalMessages.map((message) => message.role);
  assert(
    JSON.stringify(roles) === JSON.stringify(["user", "assistant", "tool", "assistant", "tool", "assistant"]),
    `unexpected final roles: ${roles.join(",")}`,
  );
  const toolResult = first.finalMessages[4]!;
  assert(String(toolResult.content).includes("notes.md"), "real list_files handler did not run");
  const finalText = String(first.finalMessages.at(-1)?.content ?? "");
  assert(finalText === "Listed the workspace files.", `unexpected final text: ${finalText}`);

  // ── Run 2: canonical history handoff replays the whole first transcript ──
  const second = createNativeAgent({ ...baseOptions, gatewayHistory: first.finalMessages } as Parameters<typeof createNativeAgent>[0]);
  await second.execute("And what did we find?");
  const replayRequest = requests[3]!;
  const replayRoles = replayRequest.messages.map((message) => message.role);
  assert(
    JSON.stringify(replayRoles) === JSON.stringify([
      "system", "user", "assistant", "tool", "assistant", "tool", "assistant", "user",
    ]),
    `turn-2 replayed roles: ${replayRoles.join(",")}`,
  );

  console.log(
    "Agent loop smoke PASS: mode activation + native loop + streaming model transport + real tool round-trip + multi-turn history verified.\n"
    + `  final text turn 1: "${finalText}"; turn-2 replayed roles: ${replayRoles.join(",")}`,
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
