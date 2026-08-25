// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import type { AgentHistoryMessage } from "@sciencediscovery/orchestration";
import type { ModelTurn, WireToolSpec } from "@sciencediscovery/model";

import {
  createNativeAgent,
  setModelTurnStreamerForTest,
  type ModelTurnStreamer,
  type NativeAgentOptions,
} from "./index.js";

interface CapturedInput {
  history: AgentHistoryMessage[];
  systemPrompt: string;
  tools: WireToolSpec[];
}

interface StructuredExample {
  constraints: string[];
  objective: string;
  outputRequirements: string[];
}

function workspace(root: string, sessionId: string): NativeAgentOptions {
  return {
    config: { baseUrl: "http://model.test", dataDir: root, model: "context-contract-stub" },
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not called"); },
    executeShell: async () => { throw new Error("not called"); },
    sessionId,
    workspaceRoot: root,
  };
}

function textTurn(text: string): ModelTurn {
  return { assistantMessage: { role: "assistant", content: text }, toolCalls: [] };
}

function toolTurn(name: string, args: Record<string, unknown>): ModelTurn {
  return {
    assistantMessage: {
      role: "assistant",
      content: "",
      tool_calls: [{ id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
    toolCalls: [{ args, id: `call-${name}`, name }],
  };
}

function canonicalHistory(history: AgentHistoryMessage[]): AgentHistoryMessage[] {
  return history.filter((message) => {
    const additional = message.additional_kwargs;
    return !(typeof additional === "object" && additional !== null && !Array.isArray(additional)
      && ((additional as Record<string, unknown>).context_contributor_message === true
        || typeof (additional as Record<string, unknown>).context_attachment_id === "string"));
  });
}

async function runExample(input: {
  mode: "dynamic" | "legacy" | "shadow";
  options: NativeAgentOptions;
  prompt: string;
  turns: ModelTurn[];
}): Promise<CapturedInput[]> {
  const calls: CapturedInput[] = [];
  let turn = 0;
  const streamer: ModelTurnStreamer = async (_endpoint, systemPrompt, history, tools, _policy, _signal, callbacks) => {
    calls.push({ history: structuredClone(history), systemPrompt, tools: structuredClone(tools) });
    callbacks?.onProgress?.();
    const result = input.turns[turn++];
    if (!result) throw new Error("context integration script exhausted");
    return result;
  };
  const restore = setModelTurnStreamerForTest(streamer);
  try {
    const agent = createNativeAgent({
      ...input.options,
      contextAssemblyMode: input.mode,
    });
    await agent.execute(input.prompt);
    return calls;
  } finally {
    restore();
  }
}

async function traceRecords(traceRoot: string, sessionPrefix: string): Promise<Array<Record<string, unknown>>> {
  const directory = (await readdir(traceRoot)).find((name) => name.startsWith(`${sessionPrefix}_`));
  assert.ok(directory, `missing trace directory for ${sessionPrefix}`);
  const paths = (await readdir(resolve(traceRoot, directory))).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(paths.map(async (name) => JSON.parse(
    await readFile(resolve(traceRoot, directory, name), "utf8"),
  ) as Record<string, unknown>));
}

async function exportExample(
  outputDirectory: string | undefined,
  name: string,
  mode: string,
  scope: string,
  structuredInput: StructuredExample,
  llmInput: CapturedInput,
): Promise<void> {
  if (!outputDirectory) return;
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, `${name}.json`), `${JSON.stringify({
    generatedBy: "NativeAgent -> ContextAssembler -> ProviderModelClient recorder",
    llmInput,
    mode,
    scope,
    structuredInput,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

test("real Node NativeAgent context contract covers modes, scopes, dynamic updates, trace phases, and examples", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "context-agent-integration-"));
  const traceRoot = resolve(root, "traces");
  const previousTrace = process.env.SCIENCE_AGENT_CONTEXT_TRACE;
  const previousTraceDirectory = process.env.SCIENCE_AGENT_CONTEXT_TRACE_DIR;
  const previousPromptBudget = process.env.SCIENCE_AGENT_CONTEXT_PROMPT_BUDGET_CHARS;
  process.env.SCIENCE_AGENT_CONTEXT_TRACE = "1";
  process.env.SCIENCE_AGENT_CONTEXT_TRACE_DIR = traceRoot;
  process.env.SCIENCE_AGENT_CONTEXT_PROMPT_BUDGET_CHARS = "5000";
  try {
    const mainInput: StructuredExample = {
      constraints: ["Use selected literature skill", "Do not execute ungoverned tools"],
      objective: "Review current evidence about TP53 resistance mechanisms",
      outputRequirements: ["Cited summary", "State uncertainty"],
    };
    const mainOptions: NativeAgentOptions = {
      ...workspace(root, "main-example"),
      runContract: JSON.stringify(mainInput),
      proposePlan: async (input) => ({
        caveats: input.caveats ?? [],
        createdAt: "2026-08-25T00:00:00.000Z",
        feasibilityConfidence: input.feasibilityConfidence,
        id: "plan-1",
        mode: "recorded",
        scope: input.scope,
        sessionId: "main-example",
        state: "recorded",
        steps: input.steps.map((description, index) => ({
          description, id: `step-${index + 1}`, status: "pending",
        })),
        updatedAt: "2026-08-25T00:00:00.000Z",
        version: 1,
      }),
      skills: [{
        content: "Search, screen, extract, and cite the selected literature before synthesis.",
        description: "Systematic literature review",
        hash: "a".repeat(64),
        id: "literature-review",
        readResource: async () => { throw new Error("not called"); },
        resources: [],
        revision: 1,
        version: "1.0.0",
      }],
      mcpTools: [{
        description: "Search a governed biomedical index",
        displayName: "Biomedical search",
        execute: async () => ({ content: [], details: {}, mcpInvocationId: "not-called" }),
        inputSchema: { properties: { query: { type: "string" } }, required: ["query"], type: "object" },
        name: "mcp__biomed__search",
        routing: { keywords: [], mode: "off", priority: 0 },
        sourceId: "biomed",
        toolId: "search",
      }],
    };
    const mainCalls = await runExample({
      mode: "dynamic",
      options: mainOptions,
      prompt: "Execute the structured research contract.",
      turns: [
        toolTurn("read_skill", { skillId: "literature-review" }),
        toolTurn("propose_plan", {
          feasibilityConfidence: "high",
          scope: "TP53 resistance evidence review",
          steps: ["search", "screen", "synthesize"],
        }),
        toolTurn("tool_search", { query: "select:mcp__biomed__search" }),
        textTurn("Structured research context verified."),
      ],
    });
    assert.equal(mainCalls.length, 4);
    assert.doesNotMatch(mainCalls[0]!.systemPrompt, /<loaded_skill/u);
    assert.doesNotMatch(mainCalls[1]!.systemPrompt, /<loaded_skill/u);
    assert.doesNotMatch(mainCalls[1]!.systemPrompt, /Search, screen, extract/u);
    assert.match(String(mainCalls[1]!.history.at(-1)?.content), /active_skills/u);
    assert.match(String(mainCalls[1]!.history.at(-1)?.content), /instructionsVisibleInHistory":true/u);
    const thirdTurnContext = mainCalls[2]!.history.map((item) => String(item.content ?? "")).join("\n");
    assert.match(thirdTurnContext, /task_state/u);
    assert.match(thirdTurnContext, /TP53 resistance evidence review/u);
    assert.equal(mainCalls[0]!.tools.some((tool) => tool.name === "mcp__biomed__search"), false);
    assert.equal(mainCalls[3]!.tools.some((tool) => tool.name === "mcp__biomed__search"), true);

    const comparisonLegacyCalls = await runExample({
      mode: "legacy",
      options: { ...mainOptions, sessionId: "main-example-legacy" },
      prompt: "Execute the structured research contract.",
      turns: [
        toolTurn("read_skill", { skillId: "literature-review" }),
        toolTurn("propose_plan", {
          feasibilityConfidence: "high",
          scope: "TP53 resistance evidence review",
          steps: ["search", "screen", "synthesize"],
        }),
        toolTurn("tool_search", { query: "select:mcp__biomed__search" }),
        textTurn("Legacy comparison captured."),
      ],
    });
    assert.equal(comparisonLegacyCalls.length, mainCalls.length);
    for (const [turn, dynamicCall] of mainCalls.entries()) {
      assert.deepEqual(canonicalHistory(comparisonLegacyCalls[turn]!.history), canonicalHistory(dynamicCall.history));
      assert.deepEqual(comparisonLegacyCalls[turn]!.tools, dynamicCall.tools);
    }
    assert.doesNotMatch(comparisonLegacyCalls[1]!.history.map((item) => item.content).join("\n"), /active_skills/u);
    assert.match(mainCalls[1]!.history.map((item) => item.content).join("\n"), /active_skills/u);
    assert.doesNotMatch(comparisonLegacyCalls[2]!.history.map((item) => item.content).join("\n"), /task_state/u);
    assert.match(mainCalls[2]!.history.map((item) => item.content).join("\n"), /task_state/u);
    assert.equal(comparisonLegacyCalls[3]!.tools.some((tool) => tool.name === "mcp__biomed__search"), true);
    assert.equal(mainCalls[3]!.tools.some((tool) => tool.name === "mcp__biomed__search"), true);

    const subagentInput: StructuredExample = {
      constraints: ["Read-only analysis", "Return a bounded brief"],
      objective: "Compare two supplied assay methods",
      outputRequirements: ["Method comparison table", "Limitations"],
    };
    const subagentCalls = await runExample({
      mode: "shadow",
      options: {
        ...workspace(root, "subagent-example"),
        contextScope: "subagent",
        runContract: JSON.stringify(subagentInput),
        subagent: { instructions: "Perform one focused comparison.", name: "Method Specialist" },
        toolPolicy: { allowed: ["list_files", "read_file"], disallowed: [] },
      },
      prompt: "Complete the structured subagent brief.",
      turns: [textTurn("Subagent brief complete.")],
    });
    assert.match(subagentCalls[0]!.systemPrompt, /Method Specialist/u);

    const reviewerInput: StructuredExample = {
      constraints: ["Do not alter the artifact", "Report unsupported claims"],
      objective: "Review a locked report against its cited evidence",
      outputRequirements: ["JSON findings", "Explicit confidence"],
    };
    const reviewerCalls = await runExample({
      mode: "dynamic",
      options: {
        ...workspace(root, "reviewer-example"),
        contextScope: "reviewer",
        runContract: JSON.stringify(reviewerInput),
        subagent: { instructions: "Review one locked artifact read-only.", name: "Reviewer Specialist" },
        toolPolicy: { allowed: [], disallowed: [] },
      },
      prompt: "Execute the structured review contract.",
      turns: [textTurn("{\"findings\":[],\"confidence\":\"high\"}")],
    });
    assert.match(reviewerCalls[0]!.systemPrompt, /Reviewer Specialist/u);

    const legacyCalls = await runExample({
      mode: "legacy",
      options: { ...workspace(root, "legacy-example"), runContract: "Legacy compatibility check" },
      prompt: "Check legacy assembly.",
      turns: [textTurn("Legacy verified.")],
    });
    assert.match(legacyCalls[0]!.systemPrompt, /Legacy compatibility check/u);

    const mainTraces = await traceRecords(traceRoot, "main-example");
    assert.equal(mainTraces.length, 4);
    for (const record of mainTraces) {
      assert.equal(record.schemaVersion, 2);
      assert.ok(record.collection);
      assert.ok(record.admitted);
      assert.ok(record.renderedContext);
      assert.ok(record.llmInput);
      const collection = record.collection as { contributors?: Array<{ durationMs?: number; status?: string }> };
      assert.ok(collection.contributors?.every((item) => item.status === "contributed" && (item.durationMs ?? -1) >= 0));
    }
    assert.equal((await traceRecords(traceRoot, "subagent-example"))[0]?.selectedPath, "legacy");
    assert.equal((await traceRecords(traceRoot, "reviewer-example"))[0]?.selectedPath, "dynamic");
    assert.equal((await traceRecords(traceRoot, "legacy-example"))[0]?.selectedPath, "legacy");

    const exampleDirectory = process.env.SCIENCE_AGENT_CONTEXT_EXAMPLE_DIR?.trim();
    await exportExample(exampleDirectory, "main-literature-review", "dynamic", "main", mainInput, mainCalls[0]!);
    await exportExample(exampleDirectory, "main-literature-review-legacy", "legacy", "main", mainInput, comparisonLegacyCalls[0]!);
    for (const [turn, dynamicCall] of mainCalls.entries()) {
      await exportExample(exampleDirectory, `main-literature-review-dynamic-turn-${turn + 1}`, "dynamic", "main", mainInput, dynamicCall);
      await exportExample(exampleDirectory, `main-literature-review-legacy-turn-${turn + 1}`, "legacy", "main", mainInput, comparisonLegacyCalls[turn]!);
    }
    await exportExample(exampleDirectory, "subagent-method-comparison", "shadow", "subagent", subagentInput, subagentCalls[0]!);
    await exportExample(exampleDirectory, "reviewer-evidence-check", "dynamic", "reviewer", reviewerInput, reviewerCalls[0]!);
  } finally {
    if (previousTrace === undefined) delete process.env.SCIENCE_AGENT_CONTEXT_TRACE;
    else process.env.SCIENCE_AGENT_CONTEXT_TRACE = previousTrace;
    if (previousTraceDirectory === undefined) delete process.env.SCIENCE_AGENT_CONTEXT_TRACE_DIR;
    else process.env.SCIENCE_AGENT_CONTEXT_TRACE_DIR = previousTraceDirectory;
    if (previousPromptBudget === undefined) delete process.env.SCIENCE_AGENT_CONTEXT_PROMPT_BUDGET_CHARS;
    else process.env.SCIENCE_AGENT_CONTEXT_PROMPT_BUDGET_CHARS = previousPromptBudget;
  }
});

test("dynamic durable channels retain plan and skill activation after source results are compacted", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "context-agent-durable-"));
  const gatewayHistory: AgentHistoryMessage[] = [
    { role: "user", content: "Load the review workflow and plan the task." },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "historical-skill",
        type: "function",
        function: { name: "read_skill", arguments: JSON.stringify({ skillId: "literature-review" }) },
      }, {
        id: "historical-plan",
        type: "function",
        function: {
          name: "propose_plan",
          arguments: JSON.stringify({ feasibilityConfidence: "high", scope: "durable TP53 review", steps: ["search"] }),
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: "historical-skill",
      name: "read_skill",
      content: "Selected skill literature-review@1.0.0 (revision 1)\n\nFULL-SKILL-BODY",
    },
    {
      role: "tool",
      tool_call_id: "historical-plan",
      name: "propose_plan",
      content: "{\"scope\":\"durable TP53 review\",\"steps\":[{\"description\":\"search\"}]}",
    },
  ];
  for (let index = 0; index < 28; index += 1) {
    gatewayHistory.push({ role: "user", content: `filler request ${index}` });
    gatewayHistory.push({ role: "assistant", content: `filler response ${index}` });
  }

  const captured: CapturedInput[] = [];
  let summaryCalls = 0;
  const streamer: ModelTurnStreamer = async (_endpoint, systemPrompt, history, tools, _policy, _signal, callbacks) => {
    callbacks?.onProgress?.();
    if (systemPrompt.startsWith("You compact conversation history")) {
      summaryCalls += 1;
      return textTurn("Earlier workflow was prepared; continue with the current research request.");
    }
    captured.push({ history: structuredClone(history), systemPrompt, tools: structuredClone(tools) });
    return textTurn("Durable state verified.");
  };
  const restore = setModelTurnStreamerForTest(streamer);
  try {
    const agent = createNativeAgent({
      ...workspace(root, "durable-compaction-example"),
      contextAssemblyMode: "dynamic",
      gatewayHistory,
      skills: [{
        content: "FULL-SKILL-BODY",
        description: "Systematic literature review",
        hash: "b".repeat(64),
        id: "literature-review",
        readResource: async () => { throw new Error("not called"); },
        resources: [],
        revision: 1,
        version: "1.0.0",
      }],
    });
    await agent.execute("Continue after compaction without forgetting the workflow.");
  } finally {
    restore();
  }
  assert.equal(summaryCalls, 1);
  assert.equal(captured.length, 1);
  const input = captured[0]!;
  const joined = input.history.map((message) => String(message.content ?? "")).join("\n");
  assert.doesNotMatch(joined, /FULL-SKILL-BODY/u, "compacted skill text must not be duplicated back into input");
  assert.match(joined, /channel="active_skills"/u);
  assert.match(joined, /literature-review/u);
  assert.match(joined, /instructionsVisibleInHistory":false/u);
  assert.match(joined, /channel="task_state"/u);
  assert.match(joined, /durable TP53 review/u);
  assert.doesNotMatch(input.systemPrompt, /FULL-SKILL-BODY/u);
});
