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

import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
  type ConnectorResult,
  type Subagent,
  type Environment,
  type NpuJob,
  type PythonExecutionResult,
  type RemoteJob,
  type ShellExecutionResult,
} from "@sciencediscovery/schema";

import { createWorkspaceTools, filterTools, normalizeWorkspaceRelativePath } from "./workspace.js";
import { ENVIRONMENT_TOOL_NAMES } from "./environment-tool-names.js";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
  MAX_SUBAGENT_MAX_TURNS,
  MAX_SUBAGENT_TIMEOUT_SECONDS,
} from "@sciencediscovery/orchestration";

test("normalizeWorkspaceRelativePath preserves nested names within each agent writable root", () => {
  const sessionRoot = resolve(process.cwd(), ".tmp", "session-root");
  const subagentRoot = resolve(sessionRoot, "subagents", "subagent-1");

  assert.equal(normalizeWorkspaceRelativePath(sessionRoot, "e/./f/g.md"), "e/f/g.md");
  assert.equal(normalizeWorkspaceRelativePath(subagentRoot, "outputs/result.csv"), "outputs/result.csv");
  assert.throws(() => normalizeWorkspaceRelativePath(subagentRoot, "../escape.csv"), /escapes the workspace/);
});

test("run_python executes code and reports output without resource selection", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `workspace-tool-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  context.after(() => rm(root, { force: true, recursive: true }));
  let executedCode = "";
  const tools = createWorkspaceTools(root, {
    enabledConnectorIds: [],
    executePython: async (code): Promise<PythonExecutionResult> => {
      executedCode = code;
      return {
        cgroupMode: "none",
        createdFiles: [],
        environmentRevisionId: "test-python",
        environmentVariables: { HOME: "/tmp", PATH: "/usr/bin" },
        executionId: "execution",
        exitCode: 0,
        finishedAt: new Date().toISOString(),
        kernelId: "ephemeral:execution",
        kernelMode: "ephemeral",
        language: "python",
        modifiedFiles: [],
        networkPolicy: "none",
        runnerVersion: "test",
        sandbox: "bubblewrap",
        startedAt: new Date().toISOString(),
        stderr: "",
        stdout: "ok",
        workingDirectory: "/workspace",
      };
    },
  });
  const tool = tools.find((candidate) => candidate.name === "run_python");
  assert.ok(tool);
  const schema = tool.parameters as { properties?: Record<string, unknown> };
  assert.equal(schema.properties?.resourceProfileId, undefined);

  const result = await tool.execute("tool-call", { code: "print('ok')" });
  assert.equal(executedCode, "print('ok')");
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /stdout:\nok/);
});

test("web search and fetch are stable first-class tools when handlers are provided", async () => {
  const calls: string[] = [];
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => ({}) as PythonExecutionResult,
    webFetch: async (toolCallId, url) => {
      calls.push(`${toolCallId}:fetch:${url}`);
      return { content: "page" };
    },
    webSearch: async (toolCallId, query) => {
      calls.push(`${toolCallId}:search:${query}`);
      return { content: "results" };
    },
  });
  const search = tools.find((tool) => tool.name === "web_search");
  const fetch = tools.find((tool) => tool.name === "web_fetch");
  assert.ok(search);
  assert.ok(fetch);
  const searchSchema = search.parameters as {
    properties?: { query?: { description?: string; maxLength?: number; minLength?: number } };
    required?: string[];
  };
  assert.deepEqual(searchSchema.required, ["query"]);
  assert.equal(searchSchema.properties?.query?.minLength, 1);
  assert.equal(searchSchema.properties?.query?.maxLength, 2_000);
  assert.match(searchSchema.properties?.query?.description ?? "", /1 to 2000/);
  assert.equal((searchSchema.properties as Record<string, unknown>).backend, undefined);
  await search.execute("search-call", { query: "TP53" });
  await fetch.execute("fetch-call", { url: "https://example.test" });
  assert.deepEqual(calls, [
    "search-call:search:TP53",
    "fetch-call:fetch:https://example.test",
  ]);
});

test("run_shell executes an existing workspace script without rewriting or path escape", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `workspace-shell-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, "run_all.sh"), "printf '%s\\n' \"$1\"\n");
  context.after(() => rm(root, { force: true, recursive: true }));
  let executedCode = "";
  const tools = createWorkspaceTools(root, {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    executeShell: async (code): Promise<ShellExecutionResult> => {
      executedCode = code;
      const timestamp = new Date().toISOString();
      return {
        cgroupMode: "none", createdFiles: [],
        environmentRevisionId: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
        environmentVariables: { HOME: "/tmp", PATH: "/usr/bin" },
        executionId: "shell", exitCode: 0,
        finishedAt: timestamp, kernelId: "ephemeral:shell", kernelMode: "ephemeral", language: "shell",
        modifiedFiles: [], networkPolicy: "none", runnerVersion: "test",
        sandbox: "bubblewrap", startedAt: timestamp, stderr: "", stdout: "ok\n",
        workingDirectory: "/workspace",
      };
    },
  });
  const tool = tools.find((candidate) => candidate.name === "run_shell");
  assert.ok(tool);
  await tool.execute("shell-call", { arguments: ["value with spaces"], scriptPath: "run_all.sh" });
  assert.equal(executedCode, "/usr/bin/bash 'run_all.sh' 'value with spaces'");
  await assert.rejects(
    tool.execute("shell-call", { scriptPath: "../outside.sh" }),
    /escapes the workspace/,
  );
});

test("run_npu_job submits only allowlisted workloads with workspace-scoped inputs", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `workspace-npu-${process.pid}-${Date.now()}`);
  await mkdir(resolve(root, "antibody_pipeline"), { recursive: true });
  await writeFile(resolve(root, "antibody_pipeline", "config.json"), "{}\n");
  context.after(() => rm(root, { force: true, recursive: true }));
  const submitted: unknown[] = [];
  const declaredArtifacts: string[] = [];
  const job: NpuJob = {
    createdAt: "2026-01-01T00:00:00.000Z",
    createdFiles: ["antibody_pipeline/runs/run-1/01_rfdiffusion/output_000000.pdb"],
    id: "npu-job-1",
    inputs: { configPath: "antibody_pipeline/config.json" },
    logs: { stderr: "", stdout: "queued", truncated: false },
    sessionId: "session-1",
    state: "queued",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workloadId: "antibody.protenix.v1",
    workspaceRoot: root,
  };
  const tools = createWorkspaceTools(root, {
    declareArtifact: async (input) => {
      declaredArtifacts.push(input.path);
      return {
        artifact: {
          createdAt: "2026-01-01T00:00:00.000Z",
          createdInSessionId: "session-1",
          createdInSessionTitle: "test session",
          currentVersion: 1,
          id: `artifact-${declaredArtifacts.length}`,
          kind: "structure",
          logicalName: input.path,
          name: input.path,
          origin: "llm_declared",
          projectId: "project-1",
          sessionId: "session-1",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        version: {
          artifactId: `artifact-${declaredArtifacts.length}`,
          content: { hash: "hash", size: 1 },
          createdAt: "2026-01-01T00:00:00.000Z",
          executionRunIds: [],
          id: `version-${declaredArtifacts.length}`,
          inputArtifactVersionIds: [],
          mediaType: "chemical/x-pdb",
          projectId: "project-1",
          sessionId: "session-1",
          sourcePath: input.path,
          version: 1,
        },
      };
    },
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    npuBroker: {
      cancel: async () => job,
      get: async () => job,
      listWorkloads: async () => [
        { description: "probe", id: "npu.smoke_test", label: "Smoke", phase: "builtin", requiresEnvironmentRevision: true },
        { description: "protenix", id: "antibody.protenix.v1", label: "Protenix", phase: "builtin", requiredInputs: ["configPath"], requiresEnvironmentRevision: true },
        { description: "custom", id: "project.custom.v1", label: "Custom", phase: "project", requiredInputs: ["configPath"] },
      ],
      logs: async () => job.logs,
      result: async () => ({ job: { ...job, state: "succeeded" } }),
      submit: async (input) => {
        submitted.push(input);
        return job;
      },
    },
  });
  const tool = tools.find((candidate) => candidate.name === "run_npu_job");
  assert.ok(tool);
  assert.match(tool.name, /^[a-zA-Z0-9_-]+$/);

  const workloads = await tool.execute("npu-list", { operation: "list_workloads" });
  assert.doesNotMatch(workloads.content[0]?.type === "text" ? workloads.content[0].text : "", /antibody\.pipeline\.v1/);
  assert.match(workloads.content[0]?.type === "text" ? workloads.content[0].text : "", /antibody\.protenix\.v1/);
  await tool.execute("npu-submit", {
    config_path: "/workspace/antibody_pipeline/config.json",
    environment_revision_id: "rev-antibody",
    operation: "submit",
    workload_id: "antibody.protenix.v1",
  });
  assert.deepEqual(submitted, [{
    environmentRevisionId: "rev-antibody",
    inputs: { configPath: "antibody_pipeline/config.json" },
    workloadId: "antibody.protenix.v1",
  }]);
  submitted.length = 0;
  await tool.execute("npu-submit-protenix", {
    config_path: "/workspace/antibody_pipeline/config.json",
    environment_revision_id: "rev-protenix",
    operation: "submit",
    workload_id: "antibody.protenix.v1",
  });
  assert.deepEqual(submitted, [{
    environmentRevisionId: "rev-protenix",
    inputs: { configPath: "antibody_pipeline/config.json" },
    workloadId: "antibody.protenix.v1",
  }]);
  submitted.length = 0;
  await tool.execute("npu-submit-custom", {
    config_path: "/workspace/antibody_pipeline/config.json",
    operation: "submit",
    workload_id: "project.custom.v1",
  });
  assert.deepEqual(submitted, [{
    inputs: { configPath: "antibody_pipeline/config.json" },
    workloadId: "project.custom.v1",
  }]);
  await assert.rejects(
    tool.execute("npu-escape", {
      config_path: "../outside.json",
      operation: "submit",
      workload_id: "antibody.protenix.v1",
    }),
    /escapes the workspace/,
  );
  await assert.rejects(
    tool.execute("npu-unsupported", { operation: "submit", workload_id: "custom.raw_shell" }),
    /Unsupported NPU workload/,
  );
  const result = await tool.execute("npu-result", { job_id: "npu-job-1", operation: "result" });
  const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(resultText, /createdFiles/);
  assert.match(resultText, /artifacts/);
  assert.deepEqual(declaredArtifacts, ["antibody_pipeline/runs/run-1/01_rfdiffusion/output_000000.pdb"]);
});

test("read_file can fall back to a read-only parent workspace", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `workspace-read-private-${process.pid}-${Date.now()}`);
  const parent = resolve(process.cwd(), ".tmp", `workspace-read-parent-${process.pid}-${Date.now()}`);
  await mkdir(resolve(root, "notes"), { recursive: true });
  await mkdir(resolve(parent, "final"), { recursive: true });
  await writeFile(resolve(root, "notes/private.md"), "private\n");
  await writeFile(resolve(parent, "final/summary.md"), "parent\n");
  context.after(() => rm(root, { force: true, recursive: true }));
  context.after(() => rm(parent, { force: true, recursive: true }));

  const tools = createWorkspaceTools(root, {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    readOnlyWorkspaceRoot: parent,
  });
  const read = tools.find((candidate) => candidate.name === "read_file");
  const list = tools.find((candidate) => candidate.name === "list_files");
  assert.ok(read);
  assert.ok(list);

  const privateResult = await read.execute("read-private", { path: "/workspace/notes/private.md" });
  assert.equal(privateResult.content[0]?.type === "text" ? privateResult.content[0].text : "", "private\n");
  const parentResult = await read.execute("read-parent", { path: "/parent_workspace/final/summary.md" });
  assert.equal(parentResult.content[0]?.type === "text" ? parentResult.content[0].text : "", "parent\n");
  const mountedParentResult = await read.execute("read-mounted-parent", { path: "/workspace/final/summary.md" });
  assert.equal(mountedParentResult.content[0]?.type === "text" ? mountedParentResult.content[0].text : "", "parent\n");
  const fallbackResult = await read.execute("read-fallback", { path: "final/summary.md" });
  assert.equal(fallbackResult.content[0]?.type === "text" ? fallbackResult.content[0].text : "", "parent\n");

  const listResult = await list.execute("list", {});
  const listText = listResult.content[0]?.type === "text" ? listResult.content[0].text : "";
  assert.match(listText, /Writable workspace:\nnotes\/private\.md/);
  assert.match(listText, /Read-only parent workspace:\nfinal\/summary\.md/);
});

test("artifact download and PDF extraction are separate tools", async () => {
  const calls: string[] = [];
  const tools = createWorkspaceTools(process.cwd(), {
    artifactDownload: async () => {
      calls.push("download");
      return {
        bytesDownloaded: 42,
        candidateId: "candidate",
        finalPath: "downloads/paper.pdf",
        jobId: "job",
        planId: "plan",
        sourceId: "arxiv",
        sourceRecordId: "1234.5678",
        status: "completed",
      };
    },
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    paperExtractPdf: async () => {
      calls.push("extract");
      return { paperAcquisitionId: "paper", textPath: "papers/paper/analysis/text.md" };
    },
  });

  const download = tools.find((candidate) => candidate.name === "artifact_download");
  const extract = tools.find((candidate) => candidate.name === "paper_extract_pdf");
  assert.ok(download);
  assert.ok(extract);
  assert.match(download.description, /does not extract/i);
  await download.execute("download-call", { candidateId: "candidate", mcpInvocationId: "invocation" });
  assert.deepEqual(calls, ["download"]);
  await extract.execute("extract-call", { artifactJobId: "job" });
  assert.deepEqual(calls, ["download", "extract"]);
});

test("project artifact tools declare, list, and read catalog entries", async () => {
  const calls: unknown[] = [];
  const artifact = {
    createdAt: "2026-01-01T00:00:00.000Z",
    createdInSessionId: "session-1",
    createdInSessionTitle: "Analysis",
    currentVersion: 1,
    id: "artifact-1",
    kind: "other" as const,
    logicalName: "result",
    name: "result",
    origin: "llm_declared" as const,
    projectId: "project-1",
    sessionId: "session-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const version = {
    artifactId: artifact.id,
    content: { hash: "a".repeat(64), size: 2 },
    createdAt: artifact.createdAt,
    executionRunIds: [],
    id: "version-1",
    inputArtifactVersionIds: [],
    mediaType: "application/octet-stream",
    projectId: artifact.projectId,
    sessionId: artifact.sessionId,
    sourcePath: "outputs/result",
    version: 1,
  };
  const tools = createWorkspaceTools(process.cwd(), {
    declareArtifact: async (input) => {
      calls.push(input);
      if (input.path === "outputs/missing") throw new Error("missing file");
      return { artifact, version };
    },
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    listArtifacts: async () => [artifact],
    readArtifact: async () => ({
      artifact,
      content: "ok",
      encoding: "utf8",
      truncated: false,
      version,
    }),
  });
  const declare = tools.find((candidate) => candidate.name === "declare_artifact");
  const list = tools.find((candidate) => candidate.name === "list_artifacts");
  const read = tools.find((candidate) => candidate.name === "read_artifact");
  assert.ok(declare);
  assert.ok(list);
  assert.ok(read);
  const declareSchema = declare.parameters as {
    properties: Record<string, unknown>;
    required?: string[];
  };
  assert.deepEqual(Object.keys(declareSchema.properties).sort(), ["description", "name", "path", "paths"]);
  assert.deepEqual(declareSchema.required ?? [], []);
  assert.deepEqual(
    declareSchema.properties.paths,
    {
      items: { maxLength: 2_000, minLength: 1, type: "string" },
      maxItems: 50,
      minItems: 1,
      type: "array",
    },
  );

  const declared = await declare.execute("declare", { path: "outputs/result" });
  assert.deepEqual(calls, [{ path: "outputs/result" }]);
  const declaredPayload = JSON.parse(declared.content[0]?.type === "text" ? declared.content[0].text : "{}") as Record<string, unknown>;
  assert.equal(declaredPayload.artifact_id, "artifact-1");
  assert.equal("artifacts" in declaredPayload, false, "single-path response retains its original top-level shape");

  const batch = await declare.execute("declare-batch", {
    description: "ignored for batch",
    name: "ignored-for-batch",
    path: "outputs/ignored-by-paths",
    paths: ["outputs/first", "outputs/missing", "outputs/last"],
  });
  assert.deepEqual(calls, [
    { path: "outputs/result" },
    { path: "outputs/first" },
    { path: "outputs/missing" },
    { path: "outputs/last" },
  ]);
  const batchPayload = JSON.parse(batch.content[0]?.type === "text" ? batch.content[0].text : "{}") as {
    artifacts: Array<Record<string, unknown>>;
  };
  assert.deepEqual(batchPayload.artifacts, [
    { artifact_id: "artifact-1", name: "result", ok: true, origin: "llm_declared", path: "outputs/first", version: 1 },
    { error: "missing file", ok: false, path: "outputs/missing" },
    { artifact_id: "artifact-1", name: "result", ok: true, origin: "llm_declared", path: "outputs/last", version: 1 },
  ]);
  await assert.rejects(declare.execute("declare-empty", {}), /path or paths is required/);
  await assert.rejects(declare.execute("declare-empty-paths", { paths: [] }), /at least one path/);
  await assert.rejects(
    declare.execute("declare-too-many", { paths: Array.from({ length: 51 }, (_, index) => `outputs/${index}`) }),
    /at most 50 paths/,
  );
  const listed = await list.execute("list", {});
  assert.match(listed.content[0]?.type === "text" ? listed.content[0].text : "", /llm_declared/);
  const readResult = await read.execute("read", { name: "result" });
  assert.match(readResult.content[0]?.type === "text" ? readResult.content[0].text : "", /"content":"ok"/);
  await assert.rejects(read.execute("read", {}), /artifact_id or name is required/);
});

test("declare_claim surfaces an instruction reminder to write alias tokens inline", async () => {
  const tools = createWorkspaceTools(process.cwd(), {
    declareClaim: async () => ({
      status: "ok",
      claimId: "claim-1",
      chipMap: {
        evidence1: { id: "ev-id-1", kind: "evidence", label: "evidence1" },
        artifact1: { id: "art-id-1", kind: "artifact", label: "artifact1", version: 1 },
      },
    }),
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
  });
  const declareClaim = tools.find((candidate) => candidate.name === "declare_claim");
  assert.ok(declareClaim, "declare_claim tool registered when callback wired");
  const result = await declareClaim!.execute("declare-claim", {
    cites_artifact_aliases: { artifact1: "art-id-1" },
    cites_evidence_aliases: { evidence1: "ev-id-1" },
    claim_type: "result_synthesis",
    confidence: "high",
    content: "Claim text",
    locator: "output.md",
  });
  const payload = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}") as Record<string, unknown>;
  assert.equal(payload.status, "ok");
  assert.equal(payload.claimId, "claim-1");
  // The instruction field reminds the LLM to write [evidence1], [artifact1]
  // inline and that aliases must be evidence+number / artifact+number (no
  // other format). Absent on error results.
  assert.ok(typeof payload.instruction === "string");
  assert.match(payload.instruction as string, /\[evidence1\]/);
  assert.match(payload.instruction as string, /\[artifact1\]/);
  assert.match(payload.instruction as string, /evidence\+number .* or artifact\+number/i);
});

test("declare_claim omits the instruction reminder when the chip map is empty; forwards instruction on business errors", async () => {
  const tools = createWorkspaceTools(process.cwd(), {
    declareClaim: async (input) => input.content === "ok-empty"
      ? { status: "ok", claimId: "claim-2", chipMap: {} }
      : input.content === "err-business"
        ? { status: "error", code: "evidence_not_found", message: "ev X not found", instruction: "re-call declare_evidence" }
        : { status: "error", code: "memory_graph_disabled", message: "disabled" },
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
  });
  const declareClaim = tools.find((candidate) => candidate.name === "declare_claim")!;
  const okEmpty = await declareClaim.execute("ok-empty-call", {
    cites_artifact_aliases: {}, cites_evidence_aliases: {},
    claim_type: "result_synthesis", confidence: "high", content: "ok-empty", locator: "report.md",
  });
  const okEmptyPayload = JSON.parse(okEmpty.content[0]?.type === "text" ? okEmpty.content[0].text : "{}") as Record<string, unknown>;
  assert.equal(okEmptyPayload.status, "ok");
  assert.equal("instruction" in okEmptyPayload, false, "no instruction when chip map is empty");

  const errored = await declareClaim.execute("err-call", {
    cites_artifact_aliases: {}, cites_evidence_aliases: {},
    claim_type: "result_synthesis", confidence: "high", content: "err", locator: "report.md",
  });
  const errPayload = JSON.parse(errored.content[0]?.type === "text" ? errored.content[0].text : "{}") as Record<string, unknown>;
  assert.equal(errPayload.status, "error");
  assert.equal("instruction" in errPayload, false, "no instruction on availability error (memory_graph_disabled)");

  const businessErr = await declareClaim.execute("err-business-call", {
    cites_artifact_aliases: {}, cites_evidence_aliases: { ev1: "missing-ev" },
    claim_type: "result_synthesis", confidence: "high", content: "err-business", locator: "report.md",
  });
  const businessPayload = JSON.parse(businessErr.content[0]?.type === "text" ? businessErr.content[0].text : "{}") as Record<string, unknown>;
  assert.equal(businessPayload.status, "error");
  assert.equal(businessPayload.instruction, "re-call declare_evidence", "instruction forwarded on business error");
});

test("MCP tools retain deferred discovery and routing metadata", async () => {
  let received: unknown;
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    mcpTools: [{
      description: "Look up a protein record",
      displayName: "UniProt lookup",
      execute: async (_toolCallId, input) => {
        received = input;
        return {
          attribution: "UniProt",
          license: "CC BY 4.0",
          records: [],
          retrievedAt: new Date().toISOString(),
          sourceId: "uniprot",
          toolId: "lookup",
          untrusted: true,
          warnings: [],
        };
      },
      inputSchema: {
        additionalProperties: false,
        properties: { accession: { type: "string" } },
        required: ["accession"],
        type: "object",
      },
      name: "mcp__uniprot__lookup",
      routing: { keywords: ["protein", "accession"], mode: "prefer", priority: 90 },
      sourceId: "uniprot",
      toolId: "lookup",
    }],
  });

  const tool = tools.find((candidate) => candidate.name === "mcp__uniprot__lookup");
  assert.ok(tool);
  assert.equal(tool.deferred, true);
  assert.deepEqual(tool.mcp, { sourceId: "uniprot", toolId: "lookup" });
  assert.deepEqual(tool.routing?.keywords, ["protein", "accession"]);
  const result = await tool.execute("call-1", { accession: "P04637" });
  assert.deepEqual(received, { accession: "P04637" });
  assert.match(result.content[0]?.text ?? "", /\"sourceId\":\"uniprot\"/);
});

test("managed environments expose governed create, delete, install, and uninstall tools", async () => {
  const environments: Environment[] = [{
    createdAt: new Date().toISOString(),
    currentRevisionId: "rev-python",
    id: "starter-python",
    kind: "starter",
    language: "python",
    name: "Starter Python",
    updatedAt: new Date().toISOString(),
  }];
  const calls: string[] = [];
  const revision = {
    channels: ["conda-forge"], createdAt: new Date().toISOString(), environmentId: "task-test", id: "rev-next",
    language: "python" as const, languageVersion: "3.12", packages: [], packageSpecHash: "hash", platform: "linux-x64",
    provisioner: "micromamba", runnerVersion: "test", snapshot: { hash: "a".repeat(64), size: 1 },
  };
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    environments,
    environmentManagement: {
      create: async (input) => {
        calls.push(`create:${input.name}:${input.language}`);
        return { ...environments[0]!, id: "task-test", kind: "task", name: input.name };
      },
      delete: async (environmentId) => { calls.push(`delete:${environmentId}`); },
      install: async (environmentId, input) => {
        calls.push(`install:${environmentId}:${input.manager}:${input.indexUrl ?? "default"}:${input.packages.join(",")}`);
        return revision;
      },
      list: async () => {
        calls.push("list");
        return environments;
      },
      uninstall: async (environmentId, input) => {
        calls.push(`uninstall:${environmentId}:${input.packages.join(",")}`);
        return { ...revision, id: "rev-uninstalled" };
      },
    },
    executePython: async () => { throw new Error("not used"); },
    executeScientific: async () => { throw new Error("not used"); },
  });
  assert.ok(tools.some((candidate) => candidate.name === ENVIRONMENT_TOOL_NAMES.list));
  assert.ok(tools.some((candidate) => candidate.name === "run_r"));
  for (const name of Object.values(ENVIRONMENT_TOOL_NAMES)) {
    assert.ok(tools.some((candidate) => candidate.name === name));
  }
  await tools.find((candidate) => candidate.name === ENVIRONMENT_TOOL_NAMES.list)!
    .execute("list-call", {});
  await tools.find((candidate) => candidate.name === ENVIRONMENT_TOOL_NAMES.create)!
    .execute("create-call", { language: "python", name: "analysis" });
  await tools.find((candidate) => candidate.name === ENVIRONMENT_TOOL_NAMES.install)!
    .execute("install-call", { environmentId: "task-test", packages: ["numpy=2.0"] });
  await tools.find((candidate) => candidate.name === ENVIRONMENT_TOOL_NAMES.install)!
    .execute("pip-install-call", {
      environmentId: "task-test",
      manager: "pip",
      packages: ["wheels/example_pkg-1.2.3-py3-none-any.whl"],
    });
  await tools.find((candidate) => candidate.name === ENVIRONMENT_TOOL_NAMES.install)!
    .execute("pip-source-install-call", {
      environmentId: "task-test",
      indexUrl: "https://download.pytorch.org/whl/cpu",
      manager: "pip",
      packages: ["torch", "torchvision"],
    });
  await tools.find((candidate) => candidate.name === ENVIRONMENT_TOOL_NAMES.uninstall)!
    .execute("uninstall-call", { environmentId: "task-test", packages: ["numpy"] });
  await tools.find((candidate) => candidate.name === ENVIRONMENT_TOOL_NAMES.delete)!
    .execute("delete-call", { environmentId: "task-test" });
  assert.deepEqual(calls, [
    "list",
    "create:analysis:python",
    "install:task-test:conda:default:numpy=2.0",
    "install:task-test:pip:default:wheels/example_pkg-1.2.3-py3-none-any.whl",
    "install:task-test:pip:https://download.pytorch.org/whl/cpu:torch,torchvision",
    "uninstall:task-test:numpy",
    "delete:task-test",
  ]);
  const installSchema = tools.find((candidate) => candidate.name === ENVIRONMENT_TOOL_NAMES.install)!.parameters as unknown as {
    properties: {
      indexUrl: { maxLength?: number };
      manager: { anyOf: Array<{ const: string }> };
      packages: { maxItems?: number; minItems?: number };
    };
    required?: string[];
  };
  assert.equal(installSchema.properties.packages.minItems, 1);
  assert.equal(installSchema.properties.indexUrl.maxLength, 2_048);
  assert.deepEqual(installSchema.properties.manager.anyOf.map((option) => option.const), ["conda", "pip"]);
  assert.ok(installSchema.required?.includes("environmentId"));
  assert.ok(installSchema.required?.includes("packages"));
  assert.equal(installSchema.required?.includes("manager"), false);
});

test("built-in workspace tool names use the strict provider-safe alphabet", () => {
  const unavailable = async () => ({}) as never;
  const tools = createWorkspaceTools(process.cwd(), {
    artifactDownload: unavailable,
    declareArtifact: unavailable,
    declareClaim: unavailable,
    declareEvidence: unavailable,
    enabledConnectorIds: [],
    environmentManagement: {
      create: unavailable,
      delete: unavailable,
      install: unavailable,
      list: async () => [],
      uninstall: unavailable,
    },
    environments: [],
    executePython: unavailable,
    executeScientific: unavailable,
    executeShell: unavailable,
    listArtifacts: unavailable,
    paperExtractPdf: unavailable,
    proposePlan: unavailable,
    queryGraph: unavailable,
    readArtifact: unavailable,
    remoteHosts: [],
    reviewCheckpoint: unavailable,
    runSubagent: unavailable,
    traceProvenance: unavailable,
    webFetch: unavailable,
    webSearch: unavailable,
  });

  assert.deepEqual(
    tools.filter((tool) => !/^[a-zA-Z0-9_-]+$/.test(tool.name)).map((tool) => tool.name),
    [],
  );
});

test("skill discovery loads frozen instructions progressively", async () => {
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    skills: [{
      content: "Follow the frozen selected workflow.",
      description: "Workflow for selected progressive loading tests.",
      hash: "b".repeat(64),
      id: "selected-skill",
      readResource: () => { throw new Error("not used"); },
      resources: [{ hash: "a".repeat(64), kind: "reference", path: "references/guide.md", size: 24 }],
      revision: 3,
      version: "1.0.0",
    }, {
      content: "Other instructions.",
      description: "Unrelated workflow.",
      hash: "c".repeat(64),
      id: "other-skill",
      readResource: () => { throw new Error("not used"); },
      resources: [],
      revision: 1,
      version: "1.0.0",
    }],
  });

  const describe = tools.find((candidate) => candidate.name === "describe_skill");
  assert.ok(describe);
  const described = await describe.execute("tool-call", { query: "progressive" });
  const describedText = described.content[0]?.type === "text" ? described.content[0].text : "";
  assert.match(describedText, /Skill: selected-skill/);
  assert.match(describedText, /Workflow for selected progressive loading tests/);
  assert.doesNotMatch(describedText, /Follow the frozen selected workflow/);

  const readSkill = tools.find((candidate) => candidate.name === "read_skill");
  assert.ok(readSkill);
  const loaded = await readSkill.execute("tool-call", { skillId: "selected-skill" });
  const loadedText = loaded.content[0]?.type === "text" ? loaded.content[0].text : "";
  assert.match(loadedText, /Selected skill selected-skill@1\.0\.0 \(revision 3\)/);
  assert.match(loadedText, /Follow the frozen selected workflow/);
  assert.match(loadedText, /references\/guide\.md \(reference, 24 bytes\)/);
  assert.equal((loaded.details as { revision?: number }).revision, 3);
});

test("read_skill_resource exposes only resources from selected frozen skills", async () => {
  let requestedPath = "";
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    skills: [{
      content: "Use selected instructions.",
      description: "Selected skill with one reference.",
      hash: "b".repeat(64),
      id: "selected-skill",
      readResource: (path) => {
        requestedPath = path;
        return {
          content: "Frozen reference content",
          hash: "a".repeat(64),
          path,
          revision: 3,
          skillId: "selected-skill",
          size: 24,
        };
      },
      resources: [{ hash: "a".repeat(64), kind: "reference", path: "references/guide.md", size: 24 }],
      revision: 3,
      version: "1.0.0",
    }],
  });

  const tool = tools.find((candidate) => candidate.name === "read_skill_resource");
  assert.ok(tool);
  const schema = tool.parameters as { properties?: { skillId?: { anyOf?: Array<{ const?: string }> } } };
  assert.deepEqual(schema.properties?.skillId?.anyOf?.map((item) => item.const), ["selected-skill"]);
  const result = await tool.execute("tool-call", { path: "references/guide.md", skillId: "selected-skill" });
  assert.equal(requestedPath, "references/guide.md");
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "Frozen reference content");
  assert.equal((result.details as { revision?: number }).revision, 3);
  await assert.rejects(
    tool.execute("tool-call", { path: "references/guide.md", skillId: "unselected-skill" } as never),
    /not selected/,
  );
});

test("planning and subagent tools preserve structured governance inputs", async () => {
  const timestamp = new Date().toISOString();
  let proposedScope = "";
  let subagentDescription = "";
  let subagentSpecialistId: string | undefined;
  let subagentMaxTurns: number | undefined;
  let subagentTimeoutSeconds: number | undefined;
  const tools = createWorkspaceTools(process.cwd(), {
    runSubagent: async (input): Promise<Subagent> => {
      subagentDescription = input.description;
      subagentSpecialistId = input.specialistId;
      subagentMaxTurns = input.maxTurns;
      subagentTimeoutSeconds = input.timeoutSeconds;
      return {
        createdAt: timestamp,
        id: "subagent-1",
        input,
        maxTurns: input.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
        parentTurnId: "turn-1",
        sessionId: "session-1",
        status: "completed",
        steps: [{
          content: "Method A found a stable result.",
          createdAt: timestamp,
          id: "assistant-result",
          kind: "assistant",
          status: "completed",
        }],
        timeoutSeconds: input.timeoutSeconds ?? DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
        turnCount: 1,
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      };
    },
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    specialists: [{
      connectorIds: ["pubmed"],
      description: "Reviews biomedical evidence and citation quality.",
      enabledSkillIds: ["evidence-extractor"],
      id: "specialist-evidence",
      name: "Evidence reviewer",
    }, {
      connectorIds: [],
      description: "Builds and debugs analysis code.",
      enabledSkillIds: [],
      id: "specialist-code",
      name: "Code implementer",
    }],
    proposePlan: async (input) => {
      proposedScope = input.scope;
      return {
        caveats: input.caveats ?? [],
        createdAt: timestamp,
        feasibilityConfidence: input.feasibilityConfidence,
        id: "plan-1",
        mode: "recorded",
        scope: input.scope,
        sessionId: "session-1",
        state: "recorded",
        steps: input.steps.map((description, index) => ({ description, id: `step-${index}`, status: "pending" })),
        updatedAt: timestamp,
        version: 1,
      };
    },
  });

  const propose = tools.find((candidate) => candidate.name === "propose_plan");
  const task = tools.find((candidate) => candidate.name === "task");
  assert.ok(propose);
  assert.ok(task);
  const taskProperties = (task.parameters as unknown as { properties: Record<string, unknown> }).properties;
  assert.deepEqual(Object.keys(taskProperties).toSorted(), [
    "brief",
    "description",
    "inputPaths",
    "max_turns",
    "prompt",
    "specialistId",
    "subagent_type",
    "timeout_seconds",
    "tools",
  ]);
  assert.deepEqual(taskProperties.subagent_type, {
    maxLength: 80,
    minLength: 1,
    type: "string",
  });
  assert.deepEqual(taskProperties.max_turns, {
    default: DEFAULT_SUBAGENT_MAX_TURNS,
    description: "Optional model-turn budget for this subagent. Increase it for unusually deep delegated work.",
    maximum: MAX_SUBAGENT_MAX_TURNS,
    minimum: DEFAULT_SUBAGENT_MAX_TURNS,
    type: "integer",
  });
  assert.deepEqual(taskProperties.timeout_seconds, {
    default: DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
    description: "Optional wall-clock runtime budget in seconds for this subagent. Increase it for long delegated work.",
    maximum: MAX_SUBAGENT_TIMEOUT_SECONDS,
    minimum: DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
    type: "integer",
  });
  assert.match(JSON.stringify(taskProperties.specialistId), /specialist-evidence/);
  assert.match(JSON.stringify(taskProperties.specialistId), /specialist-code/);
  assert.match(JSON.stringify(taskProperties.specialistId), /Reviews biomedical evidence and citation quality/);
  assert.match(task.description, /id: specialist-code; description: Builds and debugs analysis code/);
  assert.doesNotMatch(task.description, /Code implementer/);
  assert.match(task.description, /semantic match against specialist descriptions/);
  await propose.execute("plan-call", {
    caveats: ["Reference coverage may be incomplete"],
    feasibilityConfidence: "medium",
    scope: "Compare two independent analysis methods",
    steps: ["Prepare inputs", "Run both methods", "Compare outputs"],
  });
  assert.equal(proposedScope, "Compare two independent analysis methods");

  const result = await task.execute("task-call", {
    brief: {
      collaborationRules: ["Work independently", "Return one final JSON object"],
      constraints: ["Use only visible workspace files"],
      goal: "Evaluate method A independently",
      outputJsonSchema: {
        additionalProperties: false,
        properties: { summary: { type: "string" } },
        required: ["summary"],
        type: "object",
      },
      outputRequirements: ["Return a summary field"],
      version: 1,
    },
    description: "Compare method A",
    max_turns: 900,
    prompt: "Read the inputs, run method A, and summarize the result.",
    specialistId: "specialist-evidence",
    subagent_type: "method-a-worker",
    timeout_seconds: 12_000,
  });
  assert.equal(subagentDescription, "Compare method A");
  assert.equal(subagentSpecialistId, "specialist-evidence");
  assert.equal(subagentMaxTurns, 900);
  assert.equal(subagentTimeoutSeconds, 12_000);
  assert.equal((result.details as { subagent: Subagent }).subagent.input.subagentType, "method-a-worker");
  assert.equal((result.details as { subagent: Subagent }).subagent.input.brief?.goal, "Evaluate method A independently");
  assert.equal((result.details as { subagent: Subagent }).subagent.input.prompt, "Read the inputs, run method A, and summarize the result.");
  assert.deepEqual(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : ""), {
    brief: "Method A found a stable result.",
    finalText: "Method A found a stable result.",
    id: "subagent-1",
    status: "completed",
    stopReason: "completed",
    subagent_result_brief: "Method A found a stable result.",
    subagent_result_sha256: "dc9504f060f70663d4d4ea2b53542286e3bf97d0254c771bb899838d3842e4f5",
    subagent_status: "completed",
    subagent_token_usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
    turnCount: 1,
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
  });
  assert.doesNotMatch(result.content[0]?.type === "text" ? result.content[0].text : "", /Read the inputs/);
  assert.doesNotMatch(result.content[0]?.type === "text" ? result.content[0].text : "", /steps/);
});

test("two task tool calls can run subagents concurrently", async () => {
  const timestamp = new Date().toISOString();
  let active = 0;
  let maxActive = 0;
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    runSubagent: async (input): Promise<Subagent> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      active -= 1;
      return {
        createdAt: timestamp,
        id: `subagent-${input.description}`,
        input,
        maxTurns: input.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
        parentTurnId: "turn-1",
        sessionId: "session-1",
        status: "completed",
        steps: [],
        timeoutSeconds: input.timeoutSeconds ?? DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
        turnCount: 1,
      };
    },
  });
  const task = tools.find((candidate) => candidate.name === "task");
  assert.ok(task);

  const results = await Promise.all([
    task.execute("task-a", { description: "a", prompt: "Run A" }),
    task.execute("task-b", { description: "b", prompt: "Run B" }),
  ]);

  assert.equal(maxActive, 2);
  assert.deepEqual(results.map((result) => (result.details as { subagent: Subagent }).subagent.id), ["subagent-a", "subagent-b"]);
});

test("task tool summarizes failed subagents with status contract metadata", async () => {
  const timestamp = new Date().toISOString();
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    runSubagent: async (input): Promise<Subagent> => ({
      createdAt: timestamp,
      error: "Subagent result validation failed: missing summary",
      id: "subagent-failed",
      input,
      maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
      parentTurnId: "turn-1",
      resultValidation: {
        errors: ["missing summary"],
        status: "failed",
        validatedAt: timestamp,
      },
      sessionId: "session-1",
      status: "failed",
      steps: [{
        content: "I could not produce the requested JSON.",
        createdAt: timestamp,
        id: "assistant-result",
        kind: "assistant",
        status: "completed",
      }],
      timeoutSeconds: DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
      turnCount: 1,
    }),
  });
  const task = tools.find((candidate) => candidate.name === "task");
  assert.ok(task);

  const result = await task.execute("task-call", {
    description: "Invalid structured result",
    prompt: "Return structured JSON.",
  });
  const summary = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "") as Record<string, unknown>;

  assert.equal(summary.status, "failed");
  assert.equal(summary.subagent_status, "failed");
  assert.equal(summary.stopReason, "result_validation_failed");
  assert.equal(summary.subagent_error, "Subagent result validation failed: missing summary");
  assert.equal(summary.subagent_result_brief, undefined);
  assert.equal(summary.brief, "I could not produce the requested JSON.");
  assert.deepEqual((summary.resultValidation as { status?: string } | undefined)?.status, "failed");
});

test("filterTools inherits the parent tool set before applying the denylist", () => {
  const tools = [{ name: "read_file" }, { name: "run_python" }, { name: "task" }];
  assert.deepEqual(
    filterTools(tools, { allowed: null, disallowed: ["task"] }).map((tool) => tool.name),
    ["read_file", "run_python"],
  );
});

test("filterTools keeps only allowlisted tools", () => {
  const tools = [{ name: "read_file" }, { name: "run_python" }, { name: "run_shell" }];
  assert.deepEqual(
    filterTools(tools, { allowed: ["read_file", "run_shell"] }).map((tool) => tool.name),
    ["read_file", "run_shell"],
  );
});

test("filterTools denylist wins when a tool also appears in the allowlist", () => {
  const tools = [{ name: "read_file" }, { name: "task" }];
  assert.deepEqual(
    filterTools(tools, { allowed: ["read_file", "task"], disallowed: ["task"] }).map((tool) => tool.name),
    ["read_file"],
  );
});

test("propose_remote_job creates an approval card without executing remote commands", async () => {
  const timestamp = new Date().toISOString();
  let proposedCommand = "";
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    proposeRemoteJob: async (input): Promise<RemoteJob> => {
      proposedCommand = input.command;
      return {
        card: {
          command: input.command,
          inputPaths: input.inputPaths ?? [],
          mode: input.mode,
          outputs: input.outputs ?? [],
          remoteWorkingDirectory: input.remoteWorkingDirectory,
          resources: input.resources,
          targetAlias: "cluster",
          targetId: input.hostId,
        },
        createdAt: timestamp,
        id: "remote-job-1",
        outputRecords: [],
        scriptReference: "pending:remote-job-1",
        sessionId: "session-1",
        state: "awaiting_approval",
        updatedAt: timestamp,
        version: 1,
      };
    },
    remoteHosts: [{
      alias: "cluster",
      capabilities: {
        conda: true, containerRuntimes: ["apptainer"], cpuCores: 32, cuda: null, gpu: null,
        memoryBytes: 128 * 1024 ** 3, modules: true, probedAt: timestamp, scratchPaths: ["/scratch"], slurm: true,
      },
      createdAt: timestamp,
      id: "host-1",
      status: "ready",
      updatedAt: timestamp,
    }],
  });
  const tool = tools.find((candidate) => candidate.name === "propose_remote_job");
  assert.ok(tool);
  const result = await tool.execute("remote-call", {
    command: "python analysis.py",
    hostId: "host-1",
    inputPaths: ["/scratch/raw.parquet"],
    mode: "slurm",
    outputs: [{ disposition: "remote", path: "/scratch/model.bin" }],
    remoteWorkingDirectory: "/scratch/project",
    resources: { cpus: 4, gpus: 0, memoryMb: 8192, walltimeMinutes: 30 },
  });
  assert.equal(proposedCommand, "python analysis.py");
  assert.equal((result.details as RemoteJob).state, "awaiting_approval");
});

test("query_graph tool forwards the query and returns the memory-graph match", async () => {
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    queryGraph: async (query) => {
      assert.equal(query, "TP53");
      return {
        hits: [{
          label: "Paper",
          id: "https://doi.org/10.1038/tp53",
          excerpt: "TP53 mutation frequency",
          extra: { title: "TP53 in lung cancer" },
          createdAt: "2026-07-27T00:00:00Z",
        }],
        total: 1,
        truncated: false,
      };
    },
  });
  const tool = tools.find((candidate) => candidate.name === "query_graph");
  assert.ok(tool, "query_graph tool should be registered when queryGraph is provided");
  // The tool only accepts a `query` parameter.
  const properties = (tool.parameters as unknown as { properties: Record<string, unknown> }).properties;
  assert.deepEqual(Object.keys(properties), ["query"]);
  const result = await tool.execute("query-call", { query: "TP53" });
  const details = result.details as { total: number; hits: Array<{ id: string }> };
  assert.equal(details.total, 1);
  assert.equal(details.hits[0]!.id, "https://doi.org/10.1038/tp53");
  // The text content is the JSON-serialised match response for the LLM.
  const text = (result.content[0] as { text: string }).text;
  assert.ok(text.includes("TP53 mutation frequency"));
});

test("query_graph tool is absent when no queryGraph callback is wired", () => {
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
  });
  const tool = tools.find((candidate) => candidate.name === "query_graph");
  assert.equal(tool, undefined);
});

test("review_checkpoint exposes only versions and reason to its callback", async () => {
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    reviewCheckpoint: async (input, _signal, toolCallId) => {
      assert.deepEqual(input, {
        artifactVersionIds: ["version-1"],
        reason: "Stage complete",
      });
      assert.equal(toolCallId, "review-call");
      return {
        checkpoint: {
          candidateArtifactVersionIds: ["version-1"],
          createdAt: "2026-07-29T00:00:00.000Z",
          id: "checkpoint-1",
          kind: "explicit",
          reason: input.reason,
          reviewedArtifactVersionIds: ["version-1"],
          sessionId: "session-1",
          skippedArtifactVersionIds: [],
          status: "completed",
        },
        reviews: [],
      };
    },
  });
  const tool = tools.find((candidate) => candidate.name === "review_checkpoint");
  assert.ok(tool);
  const result = await tool.execute("review-call", {
    artifactVersionIds: ["version-1"],
    reason: "Stage complete",
  });
  assert.equal((result.details as { checkpoint: { status: string } }).checkpoint.status, "completed");
});
