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
 * Agent-loop real smoke: the Node-native loop against a LIVE OpenAI-compatible
 * model endpoint (credentials from SCIENCE_AGENT_LLM_*). Verifies a real tool
 * round trip: the model is asked to list workspace files, the local
 * `list_files` handler runs, and the final answer mentions the seeded file.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "@science-agent/agent-runtime";

import { createNativeAgent } from "../../services/api/src/native-agent/index.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Real smoke assertion failed: ${message}`);
}

async function main(): Promise<void> {
  const baseUrl = process.env.SCIENCE_AGENT_LLM_BASE_URL;
  const model = process.env.SCIENCE_AGENT_LLM_MODEL;
  const apiToken = process.env.SCIENCE_AGENT_LLM_API_TOKEN;
  if (!baseUrl || !model || !apiToken) throw new Error("missing SCIENCE_AGENT_LLM_* env");

  const workspaceRoot = await mkdtemp(join(tmpdir(), "sa-real-loop-"));
  await writeFile(join(workspaceRoot, "demo.csv"), "a,b\n1,2\n");
  await writeFile(join(workspaceRoot, "notes.txt"), "hello science\n");

  const events: AgentEvent[] = [];
  const agent = createNativeAgent({
    config: { apiToken, baseUrl, dataDir: workspaceRoot, model },
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("execution tool should not run in this smoke"); },
    executeShell: async () => { throw new Error("execution tool should not run in this smoke"); },
    runIdleTimeoutMs: 120_000,
    runTimeoutMs: 300_000,
    sessionId: "sess-real-loop-smoke",
    workspaceRoot,
  });
  agent.subscribe((event) => events.push(event));

  const result = await agent.execute(
    "Use the list_files tool to list the files in the workspace root, then answer with the file names you found.",
  );

  const toolEnd = events.find((event) => event.type === "tool_execution_end" && event.toolName === "list_files");
  assert(toolEnd, "the live model never called list_files");
  const finalText = String(result.finalMessages.at(-1)?.content ?? "");
  assert(/demo\.csv|notes\.txt/.test(finalText), `final answer did not mention the seeded files: ${finalText.slice(0, 400)}`);
  const usage = events.find((event) => event.type === "usage");
  assert(usage, "usage event missing");

  console.log(`Agent loop real smoke PASS. Final answer: ${finalText.slice(0, 200)}`);
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
