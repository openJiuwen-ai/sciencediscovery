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
      contextContributorFactories: [{
        id: "example.package-context",
        create: ({ scope }) => ({
          id: "example.package-snapshot",
          scopes: [scope],
          async contribute() {
            return { systemSections: [{
              content: "package working context ".repeat(500),
              id: "example.package-snapshot",
              order: 900,
              slot: "working_context",
            }] };
          },
        }),
      }],
      runContract: JSON.stringify(mainInput),
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
        toolTurn("tool_search", { query: "select:mcp__biomed__search" }),
        textTurn("Structured research context verified."),
      ],
    });
    assert.equal(mainCalls.length, 3);
    assert.doesNotMatch(mainCalls[0]!.systemPrompt, /<loaded_skill/u);
    assert.match(mainCalls[1]!.systemPrompt, /<loaded_skill id="literature-review"/u);
    assert.equal(mainCalls[0]!.tools.some((tool) => tool.name === "mcp__biomed__search"), false);
    assert.equal(mainCalls[2]!.tools.some((tool) => tool.name === "mcp__biomed__search"), true);

    const comparisonLegacyCalls = await runExample({
      mode: "legacy",
      options: { ...mainOptions, sessionId: "main-example-legacy" },
      prompt: "Execute the structured research contract.",
      turns: [
        toolTurn("read_skill", { skillId: "literature-review" }),
        toolTurn("tool_search", { query: "select:mcp__biomed__search" }),
        textTurn("Legacy comparison captured."),
      ],
    });
    assert.equal(comparisonLegacyCalls.length, mainCalls.length);
    for (const [turn, dynamicCall] of mainCalls.entries()) {
      assert.deepEqual(comparisonLegacyCalls[turn]!.history, dynamicCall.history);
      assert.deepEqual(comparisonLegacyCalls[turn]!.tools, dynamicCall.tools);
    }
    assert.doesNotMatch(comparisonLegacyCalls[0]!.systemPrompt, /package working context/u);
    assert.match(mainCalls[0]!.systemPrompt, /package working context/u);
    assert.doesNotMatch(comparisonLegacyCalls[1]!.systemPrompt, /<loaded_skill/u);
    assert.match(mainCalls[1]!.systemPrompt, /<loaded_skill id="literature-review"/u);
    assert.equal(comparisonLegacyCalls[2]!.tools.some((tool) => tool.name === "mcp__biomed__search"), true);
    assert.equal(mainCalls[2]!.tools.some((tool) => tool.name === "mcp__biomed__search"), true);

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
    assert.equal(mainTraces.length, 3);
    for (const record of mainTraces) {
      assert.equal(record.schemaVersion, 2);
      assert.ok(record.collection);
      assert.ok(record.admitted);
      assert.ok(record.renderedContext);
      assert.ok(record.llmInput);
      const collection = record.collection as { contributors?: Array<{ durationMs?: number; status?: string }> };
      assert.ok(collection.contributors?.every((item) => item.status === "contributed" && (item.durationMs ?? -1) >= 0));
    }
    const firstAdmitted = mainTraces[0]?.admitted as { diagnostics?: Array<{ code?: string }> };
    assert.ok(firstAdmitted.diagnostics?.some((item) => item.code === "CONTEXT_SECTION_TRUNCATED"));
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
