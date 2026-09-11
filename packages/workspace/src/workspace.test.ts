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
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { Check } from "typebox/value";

import {
  SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
  type ConnectorResult,
  type CreateSkillPackageRequest,
  type Subagent,
  type Environment,
  type NpuJob,
  type PythonExecutionResult,
  type RemoteJob,
  type ShellExecutionResult,
  type WorkspaceFileProvenance,
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

test("run_shell selects the latest environment by ID and preserves its execution parameters", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `workspace-tool-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  context.after(() => rm(root, { force: true, recursive: true }));
  let executedCode = "";
  let executedToolCallId = "";
  const tools = createWorkspaceTools(root, {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("legacy tool must not run"); },
    executeShell: async (code, mode, _signal, toolCallId, runnerId, environment): Promise<ShellExecutionResult> => {
      assert.equal(mode, "ephemeral");
      assert.equal(runnerId, "runner-test");
      assert.deepEqual(environment, { environmentId: "env-test", cwd: "analysis" });
      executedCode = code;
      executedToolCallId = toolCallId ?? "";
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
        language: "shell",
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
  const tool = tools.find((candidate) => candidate.name === "run_shell");
  assert.ok(tool);
  const schema = tool.parameters as { properties?: Record<string, unknown> };
  assert.equal(schema.properties?.resourceProfileId, undefined);

  const result = await tool.execute("tool-call", { command: "python -m sample", runner_id: "runner-test", environment_id: "env-test", cwd: "analysis" });
  assert.equal(executedCode, "python -m sample");
  assert.equal(executedToolCallId, "tool-call");
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /stdout:\nok/);
});

for (const selection of [
  { name: "legacy local default", localRunnerAllowed: undefined, ids: [] },
  { name: "local and remote", localRunnerAllowed: true, ids: ["runner-1"] },
  { name: "one remote only", localRunnerAllowed: false, ids: ["runner-1"] },
  { name: "multiple remotes", localRunnerAllowed: false, ids: ["runner-1", "runner-2"] },
  { name: "no Runner", localRunnerAllowed: false, ids: [] },
]) {
  test(`Runner tool schemas respect selection: ${selection.name}`, async () => {
    const calls: Array<string | undefined> = [];
    const unused = async (): Promise<never> => { throw new Error("not used"); };
    const tools = createWorkspaceTools(process.cwd(), {
      enabledConnectorIds: [], environments: [],
      localRunnerAllowed: selection.localRunnerAllowed,
      remoteRunners: selection.ids.map((runnerId) => ({ runnerId, hostAlias: runnerId, list: unused, sync: unused })),
      executePython: unused, executeShell: unused,
      environmentManagement: {
        list: async (_signal, runnerId) => { calls.push(runnerId); return []; },
        setup: unused, create: unused, delete: unused, install: unused, uninstall: unused,
      },
    });
    const inputs = {
      run_shell: { command: "echo ok" },
      environment_list: {},
      environment_setup: {},
      environment_create: { name: "analysis", language: "python" },
      environment_delete: { environmentId: "analysis" },
      environment_install: { environmentId: "analysis", packages: ["numpy"], manager: "conda" },
      environment_uninstall: { environmentId: "analysis", packages: ["numpy"] },
    };
    const localAllowed = selection.localRunnerAllowed !== false;
    for (const [name, input] of Object.entries(inputs)) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, name);
      const schema = tool.parameters as { properties: { runner_id: { description: string } } };
      const description = schema.properties.runner_id.description;
      assert.equal(Check(tool.parameters, input), localAllowed, `${name}: omission follows local selection`);
      assert.equal(Check(tool.parameters, { ...input, runner_id: "" }), false, `${name}: blank ID is invalid`);
      if (localAllowed) assert.match(description, /default: local/);
      else assert.doesNotMatch(description, /default: local/);
      for (const id of selection.ids) {
        assert.ok(description.includes(id), `${name}: allowed ID is visible`);
        assert.ok(Check(tool.parameters, { ...input, runner_id: id }), `${name}: explicit selection is valid`);
      }
      if (!localAllowed && selection.ids.length === 1) {
        assert.match(description, /Pass runner_id="runner-1"; it is the only allowed Runner/);
      } else if (!localAllowed && selection.ids.length === 0) {
        assert.match(description, /No Runner is allowed/);
      }
    }
    const list = tools.find((candidate) => candidate.name === "environment_list")!;
    if (localAllowed) {
      await list.execute("default", {});
      assert.deepEqual(calls, [undefined], "omission preserves the local-default callback contract");
    } else if (selection.ids.length) {
      await list.execute("selected", { runner_id: selection.ids[0] });
      assert.deepEqual(calls, [selection.ids[0]], "explicit Runner is forwarded unchanged");
    }
  });
}

test("get_file_provenance returns the backend record without inferring fields", async () => {
  const timestamp = "2026-08-01T10:00:00.000Z";
  const revision = {
    artifactVersionIds: [],
    createdAt: timestamp,
    fileId: "file-1",
    id: "revision-1",
    modifiedAt: timestamp,
    origin: "unknown" as const,
    path: "legacy.txt",
    projectId: "project-1",
    sessionId: "session-1",
    size: 6,
  };
  const expected: WorkspaceFileProvenance = {
    artifacts: [],
    currentRevision: revision,
    file: {
      createdAt: timestamp,
      currentRevisionId: revision.id,
      id: revision.fileId,
      path: revision.path,
      projectId: revision.projectId,
      sessionId: revision.sessionId,
      sessionTitle: "Legacy Session",
      updatedAt: timestamp,
    },
    lineage: [],
    revisions: [revision],
    sourceSession: { deleted: false, id: "session-1", title: "Legacy Session" },
  };
  let requestedPath = "";
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => ({}) as PythonExecutionResult,
    getFileProvenance: async (path) => {
      requestedPath = path;
      return expected;
    },
  });
  const tool = tools.find((candidate) => candidate.name === "get_file_provenance");
  assert.ok(tool);
  const result = await tool.execute("provenance-call", { path: "legacy.txt" });
  assert.equal(requestedPath, "legacy.txt");
  assert.deepEqual(result.details, expected);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /\"origin\": \"unknown\"/);
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
  const fixtureRoot = resolve(process.cwd(), ".tmp", `workspace-shell-${process.pid}-${Date.now()}`);
  const root = resolve(fixtureRoot, "workspace");
  const subagentRoot = resolve(root, "subagents", "subagent-1");
  await mkdir(resolve(root, "scripts"), { recursive: true });
  await mkdir(subagentRoot, { recursive: true });
  await writeFile(resolve(root, "root script.sh"), "printf '%s\\n' \"$@\"\n");
  await writeFile(resolve(root, "scripts", "child script.sh"), "printf 'child\\n'\n");
  await writeFile(resolve(subagentRoot, "agent script.sh"), "printf 'agent\\n'\n");
  await writeFile(resolve(fixtureRoot, "outside.sh"), "printf 'outside\\n'\n");
  await symlink(resolve(fixtureRoot, "outside.sh"), resolve(root, "outside-link.sh"));
  context.after(() => rm(fixtureRoot, { force: true, recursive: true }));
  const executedCodes: string[] = [];
  const tools = createWorkspaceTools(root, {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    executeShell: async (code): Promise<ShellExecutionResult> => {
      executedCodes.push(code);
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
  await tool.execute("shell-root", {
    arguments: ["value with spaces", "quote'value", "$HOME; touch never"],
    scriptPath: "root script.sh",
  });
  await tool.execute("shell-child", { scriptPath: "scripts/child script.sh" });
  assert.deepEqual(executedCodes, [
    "/usr/bin/bash '/workspace/root script.sh' 'value with spaces' 'quote'\"'\"'value' '$HOME; touch never'",
    "/usr/bin/bash '/workspace/scripts/child script.sh'",
  ]);
  await assert.rejects(
    tool.execute("shell-missing", { scriptPath: "missing.sh" }),
    /scriptPath does not exist in an authorized mount/,
  );
  await assert.rejects(
    tool.execute("shell-directory", { scriptPath: "scripts" }),
    /scriptPath must reference a regular file/,
  );
  await assert.rejects(
    tool.execute("shell-call", { scriptPath: "../outside.sh" }),
    /escapes the workspace/,
  );
  await assert.rejects(
    tool.execute("shell-symlink", { scriptPath: "outside-link.sh" }),
    /scriptPath escapes its authorized mount/,
  );

  let subagentCode = "";
  const subagentTools = createWorkspaceTools(subagentRoot, {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    executeShell: async (code) => {
      subagentCode = code;
      return {
        cgroupMode: "none", createdFiles: [], environmentRevisionId: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
        environmentVariables: { HOME: "/tmp", PATH: "/usr/bin" }, executionId: "subagent-shell", exitCode: 0,
        finishedAt: new Date().toISOString(), kernelId: "persistent:shell", kernelMode: "persistent", language: "shell",
        modifiedFiles: [], networkPolicy: "none", runnerVersion: "test", sandbox: "bubblewrap",
        startedAt: new Date().toISOString(), stderr: "", stdout: "agent\n",
        workingDirectory: "/workspace/subagents/subagent-1",
      };
    },
    readOnlyWorkspaceRoot: root,
  });
  const subagentTool = subagentTools.find((candidate) => candidate.name === "run_shell");
  assert.ok(subagentTool);
  await subagentTool.execute("subagent-script", { scriptPath: "agent script.sh" });
  assert.equal(subagentCode, "/usr/bin/bash '/workspace/subagents/subagent-1/agent script.sh'");
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
  assert.equal(JSON.stringify(tool.parameters).includes("environment_revision_id"), false);
  await assert.rejects(tool.execute("legacy-revision", { operation: "submit", environment_revision_id: "old" } as never), /use environment_id/);

  const workloads = await tool.execute("npu-list", { operation: "list_workloads" });
  assert.doesNotMatch(workloads.content[0]?.type === "text" ? workloads.content[0].text : "", /antibody\.pipeline\.v1/);
  assert.match(workloads.content[0]?.type === "text" ? workloads.content[0].text : "", /antibody\.protenix\.v1/);
  await tool.execute("npu-submit", {
    config_path: "/workspace/antibody_pipeline/config.json",
    environment_id: "env-antibody",
    operation: "submit",
    workload_id: "antibody.protenix.v1",
  });
  assert.deepEqual(submitted, [{
    environmentId: "env-antibody",
    inputs: { configPath: "antibody_pipeline/config.json" },
    workloadId: "antibody.protenix.v1",
  }]);
  submitted.length = 0;
  await tool.execute("npu-submit-protenix", {
    config_path: "/workspace/antibody_pipeline/config.json",
    environment_id: "env-protenix",
    operation: "submit",
    workload_id: "antibody.protenix.v1",
  });
  assert.deepEqual(submitted, [{
    environmentId: "env-protenix",
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

test("read_file pages a large file instead of returning it whole", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `workspace-read-page-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(resolve(root, "big.log"), Array.from({ length: 20_000 }, (_, index) => `line-${index + 1}`).join("\n"));

  const tools = createWorkspaceTools(root, {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
  });
  const read = tools.find((candidate) => candidate.name === "read_file");
  assert.ok(read);

  const first = await read.execute("read-page-1", { path: "big.log" });
  const firstText = first.content[0]?.type === "text" ? first.content[0].text : "";
  assert.equal(first.bounded, true, "read_file bounds its own output");
  assert.ok(Buffer.byteLength(firstText, "utf8") <= 50 * 1_024, `page is ${Buffer.byteLength(firstText, "utf8")} bytes`);
  assert.match(firstText, /^\[paginated file] big\.log lines 1-2000 \(/);
  assert.match(firstText, /Continue with read_file\(path="big\.log", offset=2001\)\./);
  assert.equal(firstText.includes("line-2000\n"), true);
  assert.equal(firstText.includes("line-2001"), false, "the omitted tail is not in this result");

  const second = await read.execute("read-page-2", { limit: 5, offset: 2_001, path: "big.log" });
  const secondText = second.content[0]?.type === "text" ? second.content[0].text : "";
  assert.match(secondText, /^\[paginated file] big\.log lines 2001-2005 \(/);
  assert.equal(secondText.endsWith("line-2001\nline-2002\nline-2003\nline-2004\nline-2005\n"), true);
});

test("read_file returns metadata for a binary file and never its bytes", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `workspace-read-binary-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  context.after(() => rm(root, { force: true, recursive: true }));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
    Buffer.alloc(2_048, 0x5a),
  ]);
  await writeFile(resolve(root, "plot.png"), png);
  // A PDB structure is plain ASCII and must stay readable as text.
  await writeFile(resolve(root, "5FHC.pdb"), "HEADER    HYDROLASE   5FHC\nATOM      1  N   MET A   1\nEND\n");

  const tools = createWorkspaceTools(root, {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
  });
  const read = tools.find((candidate) => candidate.name === "read_file");
  assert.ok(read);

  const binary = await read.execute("read-binary", { path: "plot.png" });
  const binaryText = binary.content[0]?.type === "text" ? binary.content[0].text : "";
  const payload = JSON.parse(binaryText) as { binary: boolean; mediaType: string; size: number };
  assert.equal(payload.binary, true);
  assert.equal(payload.mediaType, "image/png");
  assert.equal(payload.size, png.length);
  assert.equal(binaryText.includes(png.toString("base64").slice(0, 24)), false, "no base64 body");
  assert.equal(binaryText.includes("ZZZZZZZZ"), false, "no raw body");

  const structure = await read.execute("read-pdb", { path: "5FHC.pdb" });
  assert.equal(
    structure.content[0]?.type === "text" ? structure.content[0].text : "",
    "HEADER    HYDROLASE   5FHC\nATOM      1  N   MET A   1\nEND\n",
    "a PDB file is read as text, not rejected as binary",
  );
});

test("read_artifact forwards pagination and keeps a binary version out of model text", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const artifact = {
    createdAt: "2026-08-28T00:00:00.000Z",
    createdInSessionId: "session-1",
    createdInSessionTitle: "Structure session",
    currentVersion: 1,
    id: "artifact-1",
    kind: "other" as const,
    logicalName: "structure",
    name: "structure",
    origin: "llm_declared" as const,
    projectId: "project-1",
    sessionId: "session-1",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
  const version = {
    artifactId: "artifact-1",
    content: { hash: "hash-1", size: 4_096 },
    createdAt: "2026-08-28T00:00:00.000Z",
    executionRunIds: [],
    id: "version-1",
    inputArtifactVersionIds: [],
    mediaType: "image/png",
    projectId: "project-1",
    sessionId: "session-1",
    version: 1,
  };
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    readArtifact: async (input) => {
      requests.push(input);
      return {
        artifact,
        binary: true,
        encoding: "binary" as const,
        mediaType: "image/png",
        size: 4_096,
        truncated: false,
        version,
      };
    },
  });
  const read = tools.find((candidate) => candidate.name === "read_artifact");
  assert.ok(read);

  const schema = read.parameters as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(schema.properties).sort(), ["artifact_id", "limit", "name", "offset", "version"]);

  const result = await read.execute("read-artifact", { limit: 500, name: "structure", offset: 1_001 });
  assert.deepEqual(requests, [{ limit: 500, name: "structure", offset: 1_001 }]);
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  const payload = JSON.parse(text) as { binary: boolean; content?: string; encoding: string };
  assert.equal(payload.binary, true);
  assert.equal(payload.encoding, "binary");
  assert.equal("content" in payload, false, "a binary version carries no body");
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
      binary: false,
      content: "ok",
      encoding: "utf8" as const,
      mediaType: "text/plain",
      size: 2,
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

test("MCP tools retain metadata and remain exclusive unless explicitly classified", async () => {
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
  assert.equal(tool.isConcurrencySafe, undefined, "opaque MCP tools must fail closed to exclusive execution");
  assert.deepEqual(tool.mcp, { sourceId: "uniprot", toolId: "lookup" });
  assert.deepEqual(tool.routing?.keywords, ["protein", "accession"]);
  const result = await tool.execute("call-1", { accession: "P04637" });
  assert.deepEqual(received, { accession: "P04637" });
  assert.match(result.content[0]?.text ?? "", /\"sourceId\":\"uniprot\"/);
});

test("all scientific environment tools forward runner_id and setup retries are explicit", async () => {
  const calls: Array<{ operation: string; runnerId?: string; input?: unknown }> = [];
  const environments: Environment[] = [];
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [], environments,
    executePython: async () => { throw new Error("not used"); },
    executeScientific: async () => { throw new Error("not used"); },
    environmentManagement: {
      list: async (_signal, runnerId) => { calls.push({ operation: "list", runnerId }); return []; },
      create: async (input, _signal, runnerId) => { calls.push({ operation: "create", runnerId, input }); return {} as Environment; },
      delete: async (_id, _signal, runnerId) => { calls.push({ operation: "delete", runnerId }); },
      install: async (_id, input, _signal, runnerId) => { calls.push({ operation: "install", runnerId, input }); return {} as never; },
      uninstall: async (_id, input, _signal, runnerId) => { calls.push({ operation: "uninstall", runnerId, input }); return {} as never; },
      setup: async (retry, _signal, runnerId) => { calls.push({ operation: "setup", runnerId, input: retry }); return {} as never; },
    },
  });
  const execute = async (name: string, input: Record<string, unknown>) => {
    const tool = tools.find(t => t.name === name)!;
    assert.match(JSON.stringify(tool.parameters), /runner_id/);
    return tool.execute("call", { runner_id: "runner-1", ...input });
  };
  await execute("environment_list", {});
  await execute("environment_create", { name: "task", language: "r" });
  await execute("environment_install", { environmentId: "task-1", packages: ["numpy"], manager: "conda" });
  await execute("environment_uninstall", { environmentId: "task-1", packages: ["numpy"] });
  await execute("environment_delete", { environmentId: "task-1" });
  await execute("environment_setup", {});
  await execute("environment_setup", { retry: true });
  assert.equal(calls.length, 7);
  assert.ok(calls.every(call => call.runnerId === "runner-1"));
  assert.deepEqual(calls[1]?.input, { name: "task", language: "r" });
  assert.deepEqual(calls.slice(-2).map(call => call.input), [false, true]);
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
  assert.equal(tools.some((candidate) => candidate.name === "run_r" || candidate.name === "run_python"), false);
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
    queryGraph: unavailable,
    readArtifact: unavailable,
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

test("propose_skill_library_update only submits dry-run self-evolution proposals", async () => {
  let captured: unknown;
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    proposeSkillLibraryUpdate: async (input) => {
      captured = input;
      return {
        createdAt: "2026-08-25T00:00:00.000Z",
        id: "proposal-1",
        libraryId: input.libraryId,
        rationale: input.rationale,
        request: input,
        result: { conflicts: [], diagnostics: [], diff: { added: [], deleted: [], modified: [] }, dryRun: true },
        sourceRefs: input.sourceRefs,
        status: "pending",
        updatedAt: "2026-08-25T00:00:00.000Z",
      };
    },
  });

  const tool = tools.find((candidate) => candidate.name === "propose_skill_library_update");
  assert.ok(tool);
  const result = await tool.execute("tool-call", {
    libraryId: "project-skills",
    operations: [{ package: { files: [{ content: "---\nname: learned-skill\ndescription: Learned workflow.\n---\n\nUse it.\n", path: "SKILL.md" }] }, type: "upsert" }],
    rationale: "A reusable workflow was found.",
  });
  assert.deepEqual(captured, {
    author: { kind: "self-evolution", name: "Agent self-evolution proposal" },
    dryRun: true,
    libraryId: "project-skills",
    operations: [{ package: { files: [{ content: "---\nname: learned-skill\ndescription: Learned workflow.\n---\n\nUse it.\n", path: "SKILL.md" }] }, type: "upsert" }],
    rationale: "A reusable workflow was found.",
    sourceRefs: [],
  });
  assert.match(result.content[0]?.text ?? "", /proposal-1/);
});

test("propose_skill_library_update can generate valid SKILL.md from structured fields", async () => {
  let captured: unknown;
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    proposeSkillLibraryUpdate: async (input) => {
      captured = input;
      return {
        createdAt: "2026-08-25T00:00:00.000Z",
        id: "proposal-structured",
        libraryId: input.libraryId,
        rationale: input.rationale,
        request: input,
        result: { conflicts: [], diagnostics: [], diff: { added: [], deleted: [], modified: [] }, dryRun: true },
        sourceRefs: input.sourceRefs,
        status: "pending",
        updatedAt: "2026-08-25T00:00:00.000Z",
      };
    },
  });

  const tool = tools.find((candidate) => candidate.name === "propose_skill_library_update");
  assert.ok(tool);
  await tool.execute("tool-call", {
    libraryId: "project-skills",
    operations: [{
      skill: {
        description: "Reusable checks for tiny task outputs.",
        instructions: "Check the task output, record reusable steps, and keep the result concise.",
        metadata: { source: "self-evolution" },
        name: "tiny-task-check",
        version: "1.0.0",
      },
      type: "upsert_skill",
    }],
    rationale: "The same tiny task pattern recurred.",
  });

  const operation = (captured as { operations: Array<{ package: { files: Array<{ content: string; path: string }> }; type: string }> }).operations[0]!;
  assert.equal(operation.type, "upsert");
  assert.equal(operation.package.files[0]?.path, "SKILL.md");
  assert.match(operation.package.files[0]?.content ?? "", /^---\nname: "tiny-task-check"\ndescription: "Reusable checks for tiny task outputs\."/);
  assert.match(operation.package.files[0]?.content ?? "", /\n---\n\nCheck the task output/);
});

test("publish_skill_library_update submits selected proposals", async () => {
  let captured: unknown;
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    publishSkillLibraryUpdate: async (input) => {
      captured = input;
      return {
        proposals: input.proposalIds.map((id) => ({
          createdAt: "2026-08-25T00:00:00.000Z",
          id,
          libraryId: "project-skills",
          rationale: "Ready to publish.",
          request: { author: { kind: "self-evolution" }, operations: [] },
          result: { conflicts: [], diagnostics: [], diff: { added: [], deleted: [], modified: [] }, dryRun: true },
          sourceRefs: [],
          status: "published",
          updatedAt: "2026-08-25T00:00:00.000Z",
        })),
        result: {
          conflicts: [],
          diagnostics: [],
          diff: { added: [], deleted: [], modified: [] },
          dryRun: false,
          version: {
            author: { kind: "self-evolution" },
            contentHash: "a".repeat(64),
            createdAt: "2026-08-25T00:00:00.000Z",
            id: "version-1",
            libraryId: "project-skills",
            skills: [],
          },
        },
      };
    },
  });

  const tool = tools.find((candidate) => candidate.name === "publish_skill_library_update");
  assert.ok(tool);
  const result = await tool.execute("tool-call", { proposalIds: ["proposal-1", "proposal-2"] });
  assert.deepEqual(captured, { proposalIds: ["proposal-1", "proposal-2"] });
  assert.match(result.content[0]?.text ?? "", /version-1/);
});

test("skill loading reads frozen instructions directly by exact id", async () => {
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    skills: [{
      content: "Follow the frozen selected workflow.",
      description: "Workflow for selected progressive loading tests.",
      hash: "b".repeat(64),
      id: "selected-skill",
      packagePath: "$SCIENCEDISCOVERY_SKILLS_DIR/selected-skill",
      readResource: () => { throw new Error("not used"); },
      resources: [{ hash: "a".repeat(64), kind: "reference", path: "references/guide.md", size: 24 }],
      revision: 3,
      version: "1.0.0",
    }, {
      content: "Other instructions.",
      description: "Unrelated workflow.",
      hash: "c".repeat(64),
      id: "other-skill",
      packagePath: "$SCIENCEDISCOVERY_SKILLS_DIR/other-skill",
      readResource: () => { throw new Error("not used"); },
      resources: [],
      revision: 1,
      version: "1.0.0",
    }],
  });

  assert.equal(tools.some((candidate) => candidate.name === "describe_skill"), false);

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
      packagePath: "$SCIENCEDISCOVERY_SKILLS_DIR/selected-skill",
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

test("ordinary file and shell tools use the pre-mounted complete frozen Skill package", async (context) => {
  const fixtureRoot = resolve(process.cwd(), ".tmp", `mounted-skill-${process.pid}-${Date.now()}`);
  const root = resolve(fixtureRoot, "workspace");
  const skillRoot = resolve(fixtureRoot, "skill-snapshot");
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(resolve(skillRoot, "selected-skill", "scripts"), { recursive: true }),
    mkdir(resolve(skillRoot, "selected-skill", "references"), { recursive: true }),
  ]);
  await writeFile(resolve(skillRoot, "selected-skill", "SKILL.md"), "Frozen instructions\n");
  await writeFile(resolve(skillRoot, "selected-skill", "references", "guide.md"), "Frozen guide\n");
  await writeFile(resolve(skillRoot, "selected-skill", "scripts", "run.sh"), "printf 'not auto-run\\n'\n");
  context.after(() => rm(fixtureRoot, { force: true, recursive: true }));
  const executedCodes: string[] = [];
  const executedToolCallIds: (string | undefined)[] = [];
  const tools = createWorkspaceTools(root, {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    executeShell: async (code, _kernelMode, _signal, toolCallId): Promise<ShellExecutionResult> => {
      executedCodes.push(code);
      executedToolCallIds.push(toolCallId);
      const timestamp = new Date().toISOString();
      return {
        cgroupMode: "none", createdFiles: [], environmentRevisionId: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
        environmentVariables: {}, executionId: "shell", exitCode: 0, finishedAt: timestamp,
        kernelId: "shell", kernelMode: "ephemeral", language: "shell", modifiedFiles: [],
        networkPolicy: "none", runnerVersion: "test", sandbox: "bubblewrap", startedAt: timestamp,
        stderr: "", stdout: "ok\n", workingDirectory: "/workspace",
      };
    },
    skillPackagesRoot: skillRoot,
    skills: [{
      content: "Frozen instructions",
      description: "Selected complete package.",
      hash: "b".repeat(64),
      id: "selected-skill",
      packagePath: "$SCIENCEDISCOVERY_SKILLS_DIR/selected-skill",
      readResource: () => { throw new Error("not used"); },
      resources: [{ hash: "a".repeat(64), kind: "script", path: "scripts/run.sh", size: 22 }],
      revision: 7,
      version: "1.0.0",
    }],
  });

  assert.equal(tools.some((candidate) => candidate.name === "materialize_skill_resource"), false);
  await assert.rejects(readFile(resolve(root, "skills", "selected-skill", "SKILL.md")), /ENOENT/);
  const readTool = tools.find((candidate) => candidate.name === "read_file");
  const listTool = tools.find((candidate) => candidate.name === "list_files");
  const shellTool = tools.find((candidate) => candidate.name === "run_shell");
  assert.ok(readTool);
  assert.ok(listTool);
  assert.ok(shellTool);

  // Tool descriptions are model-visible, so they must address the mounts through
  // the variables. A bare /skills is only a real path under bubblewrap and would
  // send the model to a non-existent location on macOS Seatbelt.
  assert.match(shellTool.description, /\$SCIENCEDISCOVERY_SKILLS_DIR/);
  for (const tool of tools) {
    assert.doesNotMatch(tool.description, /(^|[^A-Z_])\/skills\b/, `${tool.name} description hardcodes the bind path`);
    assert.doesNotMatch(tool.description, /(^|[^A-Z_])\/skill-extensions\b/, `${tool.name} description hardcodes the bind path`);
  }

  // The prompt advertises the environment-variable form, which these Node-side
  // tools never see expanded; the bubblewrap bind path stays valid as an alias.
  for (const packageRoot of [
    "$SCIENCEDISCOVERY_SKILLS_DIR",
    "${SCIENCEDISCOVERY_SKILLS_DIR}",
    "/skills",
  ]) {
    const readResult = await readTool.execute("read", { path: `${packageRoot}/selected-skill/SKILL.md` });
    assert.equal(readResult.content[0]?.type === "text" ? readResult.content[0].text : "", "Frozen instructions\n");
  }
  const listed = await listTool.execute("list", {});
  assert.match(
    listed.content[0]?.type === "text" ? listed.content[0].text : "",
    /\$SCIENCEDISCOVERY_SKILLS_DIR\/selected-skill\/scripts\/run\.sh/,
  );

  // Every accepted spelling produces the same portable command, so a script runs
  // by path on bubblewrap and on macOS Seatbelt, where /skills does not exist.
  for (const scriptPath of [
    "$SCIENCEDISCOVERY_SKILLS_DIR/selected-skill/scripts/run.sh",
    "/skills/selected-skill/scripts/run.sh",
  ]) {
    await shellTool.execute("shell", { arguments: ["value with spaces"], kernelMode: "ephemeral", scriptPath });
  }
  assert.deepEqual(executedCodes, [
    "/usr/bin/bash \"${SCIENCEDISCOVERY_SKILLS_DIR}\"/'selected-skill/scripts/run.sh' 'value with spaces'",
    "/usr/bin/bash \"${SCIENCEDISCOVERY_SKILLS_DIR}\"/'selected-skill/scripts/run.sh' 'value with spaces'",
  ]);
  // The Skill mount must not cost run_shell its file-provenance attribution.
  assert.deepEqual(executedToolCallIds, ["shell", "shell"]);
});

test("create_skill requires the selected skill-creator instructions before mutating the catalog", async () => {
  let request: CreateSkillPackageRequest | undefined;
  const tools = createWorkspaceTools(process.cwd(), {
    createSkill: async (input) => {
      request = input;
      return {
        createdAt: "2026-08-20T00:00:00.000Z",
        draftId: "11111111-1111-4111-8111-111111111111",
        fileCount: 1 + (input.resources?.length ?? 0),
        name: input.name,
        updatedAt: "2026-08-20T00:00:00.000Z",
      };
    },
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    skills: [{
      content: "Create focused skills, then call create_skill exactly once.",
      description: "Create a Skill from an explicit user request.",
      hash: "c".repeat(64),
      id: "skill-creator",
      packagePath: "$SCIENCEDISCOVERY_SKILLS_DIR/skill-creator",
      readResource: () => { throw new Error("not used"); },
      resources: [],
      revision: 1,
      version: "1.0.0",
    }],
  });
  const create = tools.find((tool) => tool.name === "create_skill");
  const read = tools.find((tool) => tool.name === "read_skill");
  assert.ok(create);
  assert.ok(read);

  const parameters = {
    description: "Checks a result against a reusable rubric.",
    instructions: "# Workflow\n\nApply the rubric and report failures.",
    name: "rubric-checker",
    resources: [{ content: "# Rubric\n\n- Complete\n", path: "references/rubric.md" }],
    version: "1.0.0",
  };
  await assert.rejects(create.execute("create-before-read", parameters), /Load skill-creator/);
  await read.execute("read-creator", { skillId: "skill-creator" });
  const result = await create.execute("create-after-read", parameters);

  assert.equal(request?.name, "rubric-checker");
  assert.equal(request?.metadata?.version, "1.0.0");
  assert.equal(request?.resources?.[0]?.path, "references/rubric.md");
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /pending draft/);
});

test("subagent tools preserve structured governance inputs", async () => {
  const timestamp = new Date().toISOString();
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
  });

  const task = tools.find((candidate) => candidate.name === "task");
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

test("independent SSH/SLURM jobs are not offered to the model", () => {
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [], executePython: async () => { throw new Error("not used"); },
    executeShell: async () => { throw new Error("not used"); },
  });
  assert.equal(tools.some((tool) => tool.name === "propose_remote_job"), false);
  const shell = tools.find((tool) => tool.name === "run_shell")!;
  assert.match(JSON.stringify(shell.parameters), /runner_id.*local/);
  assert.equal(tools.some((tool) => tool.name === "run_python" || tool.name === "run_r"), false);
  assert.equal(JSON.stringify(shell.parameters).includes("environmentRevisionId"), false);
  assert.equal(JSON.stringify(shell.parameters).includes("kernelMode"), false);
});

test("workspace_transfer exposes explicit mappings and independent management operations", async () => {
  const calls: string[] = [];
  const record = { id: "transfer", state: "queued" } as import("@sciencediscovery/schema").WorkspaceTransfer;
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [], executePython: async () => { throw new Error("unused"); },
    workspaceTransfers: {
      workspaces: () => [{ id: "own", runnerId: "local", description: "Local" }],
      start: async (input) => { calls.push(JSON.stringify(input)); return record; },
      get: (id) => { calls.push(`status:${id}`); return record; },
      list: () => [record], cancel: async (id) => { calls.push(`cancel:${id}`); return record; },
    },
  });
  const tool = tools.find((tool) => tool.name === "workspace_transfer")!;
  assert.ok(tool);
  const listed = await tool.execute("list", { operation: "workspaces" });
  assert.match((listed.content[0] as { text: string }).text, /own/);
  await tool.execute("copy", { operation: "start", source_workspace_id: "own", target_workspace_id: "remote", files: [{ source_path: "in", target_path: "out" }] });
  assert.deepEqual(JSON.parse(calls[0]!), { sourceWorkspaceId: "own", targetWorkspaceId: "remote", files: [{ sourcePath: "in", targetPath: "out" }], conflict: "reject" });
  await tool.execute("status", { operation: "status", transfer_id: "transfer" });
  await tool.execute("cancel", { operation: "cancel", transfer_id: "transfer" });
  assert.deepEqual(calls.slice(1), ["status:transfer", "cancel:transfer"]);
  await assert.rejects(tool.execute("missing", { operation: "start" }), /explicit file mappings/);
});

test("Shell background mode and management tools do not start additional Shells", async () => {
  const calls: string[] = [];
  const job = { id: "job", state: "running", runnerId: "remote" } as import("@sciencediscovery/schema").AgentShellExecution;
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [], executePython: async () => { throw new Error("unused"); },
    executeShell: async () => { throw new Error("legacy endpoint must not run"); },
    shellExecutions: {
      start: async (code, input, _signal, call, runner) => { calls.push(JSON.stringify({ code, input, call, runner })); return job; },
      wait: async (id, ms) => { calls.push(`wait:${id}:${ms}`); return job; },
      get: async () => job, list: () => [job],
      logs: async (id, cursor) => { calls.push(`logs:${id}:${cursor}`); return { chunks: [], nextCursor: 0, retentionTruncated: false, truncated: false }; },
      cancel: async (id) => { calls.push(`cancel:${id}`); return job; },
    },
  });
  const shell = tools.find((tool) => tool.name === "run_shell")!;
  const background = await shell.execute("background", { command: "python -m sample", background: true, runner_id: "remote", environment_id: "env", cwd: "input" });
  assert.equal(calls.length, 1, "background returns on acceptance without waiting");
  assert.deepEqual(JSON.parse(calls[0]!), { code: "python -m sample", input: { environmentId: "env", cwd: "input" }, call: "background", runner: "remote" });
  assert.match((background.content[0] as { text: string }).text, /still running/);
  await shell.execute("foreground", { command: "echo next", wait_ms: 5 });
  assert.equal(calls.at(-1), "wait:job:5");
  await tools.find((tool) => tool.name === "execution_status")!.execute("status", { execution_id: "job", wait_ms: 0 });
  await tools.find((tool) => tool.name === "execution_logs")!.execute("logs", { execution_id: "job", cursor: 3 });
  await tools.find((tool) => tool.name === "execution_cancel")!.execute("cancel", { execution_id: "job" });
  assert.deepEqual(calls.slice(-3), ["wait:job:0", "logs:job:3", "cancel:job"]);
});

test("sync_remote_workspace exposes only explicit list, push, and pull operations", async () => {
  const calls: string[] = [];
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not used"); },
    remoteRunners: [{
      runnerId: "runner-1",
      description: "GPU analysis",
      hostAlias: "linux-runner",
      list: async () => [{ modifiedAt: "2026-08-31T00:00:00.000Z", path: "results/report.md", size: 12 }],
      sync: async (input: { conflict: "overwrite" | "reject"; direction: "pull" | "push"; paths: string[] }) => {
        calls.push(`${input.direction}:${input.conflict}:${input.paths.join(",")}`);
        return {
          files: input.paths,
          record: {
            bytes: 12,
            createdAt: "2026-08-31T00:00:00.000Z",
            direction: input.direction,
            fileCount: 1,
            hostId: "host-1",
            id: "sync-1",
            paths: input.paths,
            sessionId: "session-1",
            status: "completed",
          },
        };
      },
    }],
  });
  const tool = tools.find((candidate) => candidate.name === "sync_remote_workspace");
  assert.ok(tool);
  assert.match(tool.description, /Nothing is mirrored automatically/);
  const listed = await tool.execute("list-call", { runner_id: "runner-1", operation: "list" });
  assert.match((listed.content[0] as { text: string }).text, /results\/report\.md/);
  await tool.execute("push-call", { runner_id: "runner-1", operation: "push", paths: ["inputs/data.csv"] });
  await tool.execute("pull-call", { conflict: "overwrite", runner_id: "runner-1", operation: "pull", paths: ["results"] });
  assert.deepEqual(calls, ["push:reject:inputs/data.csv", "pull:overwrite:results"]);
  // A machine this Session may not use is refused rather than silently routed.
  await assert.rejects(
    tool.execute("other-call", { runner_id: "someone-elses-box", operation: "list" }),
    /may not use someone-elses-box/,
  );
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
