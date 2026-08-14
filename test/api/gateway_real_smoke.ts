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
 * Real-model adapter smoke: GatewayAgent -> real Python Gateway ->
 * live OpenAI-compatible model -> proxy tool callback into the REAL
 * createWorkspaceTools list_files handler -> streamed answer.
 *
 * Launched by run_real_smoke.sh, which starts the gateway and passes:
 *   GATEWAY_URL, SCIENCE_AGENT_LLM_BASE_URL/MODEL/API_TOKEN
 */
import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import type { AgentEvent } from "@science-agent/agent-runtime";

import { createGatewayAgent, toolCallbackRegistry } from "../../services/api/src/gateway-agent.js";

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
  const gatewayUrl = process.env.GATEWAY_URL ?? "http://127.0.0.1:4316";
  const baseUrl = process.env.SCIENCE_AGENT_LLM_BASE_URL!;
  const model = process.env.SCIENCE_AGENT_LLM_MODEL!;
  const apiToken = process.env.SCIENCE_AGENT_LLM_API_TOKEN!;
  if (!baseUrl || !model || !apiToken) throw new Error("missing SCIENCE_AGENT_LLM_* env");

  const callback = await startCallbackServer();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "sa-real-"));
  await writeFile(join(workspaceRoot, "demo.csv"), "a,b\n1,2\n");
  await writeFile(join(workspaceRoot, "notes.txt"), "hello science\n");

  const notUsed = async () => {
    throw new Error("execution tool should not run in this smoke");
  };
  const agent = createGatewayAgent({
    sessionId: "sess-real-adapter-smoke",
    gatewayUrl,
    callbackUrl: callback.url,
    config: { apiToken, baseUrl, dataDir: workspaceRoot, model },
    enabledConnectorIds: [],
    executePython: notUsed as never,
    executeShell: notUsed as never,
    skills: [],
    workspaceRoot,
  } as never);

  const events: AgentEvent[] = [];
  agent.subscribe((event) => events.push(event));
  await agent.prompt("List the files in the workspace and tell me their names. Do not run any code.");
  callback.server.close();

  const toolStart = events.find((e) => e.type === "tool_execution_start") as Extract<AgentEvent, { type: "tool_execution_start" }> | undefined;
  const toolEnd = events.find((e) => e.type === "tool_execution_end") as Extract<AgentEvent, { type: "tool_execution_end" }> | undefined;
  const text = events
    .filter((e) => e.type === "message_update")
    .map((e) => (e as { assistantMessageEvent: { type: string; delta?: string } }).assistantMessageEvent)
    .filter((u) => u.type === "text_delta")
    .map((u) => u.delta ?? "")
    .join("");

  const problems: string[] = [];
  if (toolStart?.toolName !== "list_files") problems.push(`expected a list_files call, got ${toolStart?.toolName ?? "none"}`);
  if (!JSON.stringify(toolEnd?.result ?? {}).includes("demo.csv")) problems.push("tool result missing real workspace listing");
  if (!text.includes("demo.csv") || !text.includes("notes.txt")) problems.push(`final answer did not name the files: "${text.trim()}"`);

  if (problems.length) {
    console.error("Real adapter smoke FAIL:\n- " + problems.join("\n- "));
    console.error("events:", JSON.stringify(events.map((e) => e.type)));
    process.exit(1);
  }
  console.log(`Real adapter smoke PASS (${model}).`);
  console.log(`  final answer: ${text.trim().replace(/\n/g, " ")}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Real adapter smoke ERROR:", error);
  process.exit(1);
});
