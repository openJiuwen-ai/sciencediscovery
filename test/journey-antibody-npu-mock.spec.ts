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

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createExecutionSignature, EXECUTION_SIGNATURE_HEADER, EXECUTION_TIMESTAMP_HEADER } from "../services/runner/dist/index.js";
import { expect } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import { artifactTree, cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel,
  sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";

test.describe("journey-antibody-npu-mock.spec", {
  tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"],
}, () => {

/**
 * E2E-META
 * Purpose: A user completes the antibody-design Agent/Skill/remote Runner/Artifact journey without NPU hardware.
 * Steps:
 *   1. Register a journey-owned proxy Runner advertising one usable Ascend card and select it for the Session.
 *   2. Ask the real JiuwenSwarm-backed product Agent to load antibody-design, sync inputs, choose an environment, and launch the Skill's managed Shell script.
 *   3. The proxy supplies a ready managed-environment record, records selected NPU devices, and substitutes tiny deterministic shell stages before forwarding to the real isolated Runner; no environment install, model, or NPU instruction runs.
 *   4. Check one pipeline submission, committed zero-exit receipts, remote-to-local output transfer, report/CSV/CIF Artifacts, and the answer visible to the user.
 * Environment: Isolated production API/Web/Runner/JiuwenSwarm stack from ci:e2e; proxy supplies a synthetic managed Python identity, with no Ascend driver or network download.
 * Type: mocked product E2E; the stage output is synthetic and does not prove NPU inference.
 * LLM: journey-owned scripted OpenAI-compatible model.
 * WebSearch: none
 * PaperSources: none
 * MCP: ScienceDiscovery's real JiuwenSwarm tool bridge.
 * OtherExternal: none; the proxy and the real Runner are loopback-only.
 * Credentials: isolated E2E_API_TOKEN, never printed.
 * CostSideEffects: temporary Project/Session/model/remote-host records on the isolated stack, cleaned in finally.
 */
test("Agent 使用 antibody-design 调用 mock NPU Runner 并交付产物", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(300_000);
  const token = process.env.E2E_API_TOKEN;
  const runnerToken = process.env.SCIENCE_AGENT_RUNNER_TOKEN ?? "sciencediscovery-runner-local";
  const runnerUrl = process.env.SCIENCE_AGENT_RUNNER_URL;
  expect(token, "the isolated E2E token must be available").toBeTruthy();
  expect(runnerUrl, "the isolated stack must expose its Runner URL").toBeTruthy();
  const runName = `npu-mock-${Date.now()}`;
  const root = `antibody_pipeline/runs/${runName}`;
  const report = `${root}/05_screening/protenix_screening_report.md`;
  const csv = `${root}/05_screening/protenix_screening_summary.csv`;
  const cif = `${root}/04_protenix_output/rank_001.cif`;
  const outputs = [report, csv, cif];
  const inputs = ["antibody_pipeline/inputs/target_antigen.pdb", "antibody_pipeline/inputs/antibody_framework.pdb",
    "antibody_pipeline/config.json"];
  const scriptPath = "$SCIENCEDISCOVERY_SKILLS_DIR/antibody-design/scripts/run_sandbox_pipeline.sh";
  const inventory = { capturedAt: new Date().toISOString(), supported: true,
    devices: [{ chipName: "910B3", health: "OK", hostIndex: 4, sandboxUsable: true }] };
  const mockEnvironment = { id: "mock-python", name: "Mock managed Python", kind: "task", language: "python",
    status: "ready", currentRevisionId: "mock-python-v1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const environmentSnapshot = Buffer.from(JSON.stringify({ environmentId: mockEnvironment.id,
    revisionId: mockEnvironment.currentRevisionId, packages: ["python=3.12"], synthetic: true }));
  const environmentHash = createHash("sha256").update(environmentSnapshot).digest("hex");
  const mockRevision = { id: mockEnvironment.currentRevisionId, environmentId: mockEnvironment.id, language: "python",
    languageVersion: "3.12", createdAt: mockEnvironment.createdAt, channels: [], packages: ["python=3.12"],
    packageSpecHash: environmentHash, platform: "linux-amd64", provisioner: "mock", runnerVersion: "mock",
    snapshot: { hash: environmentHash, size: environmentSnapshot.length } };
  const intercepted: Array<{ code: string; executionId: string; npuDevices: number[]; phase: string }> = [];
  const proxyErrors: string[] = [];
  let proxy: Server | undefined;
  let hostId: string | undefined;
  let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
  let stub: Awaited<ReturnType<typeof scriptedModel>> | undefined;

  const api = async <T>(path: string, method = "GET", data?: unknown): Promise<T> => {
    const response = await page.request.fetch(`${apiBaseUrl()}${path}`, {
      method, headers: authorizationHeader(), ...(data === undefined ? {} : { data }),
    });
    if (!response.ok()) throw new Error(`${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const mockCode = (phase: string) => {
    if (phase === "probe") return "printf 'managed dependencies ready\\n'";
    if (phase === "prepare") return "sleep 1; mkdir -p antibody_pipeline/models; printf 'prepared\\n' > antibody_pipeline/models/.mock-prepared";
    if (phase === "validate") return "test -s antibody_pipeline/models/.mock-prepared; printf 'inputs validated\\n'";
    return [
      "sleep 1",
      `mkdir -p '${root}/01_rfdiffusion' '${root}/02_proteinmpnn' '${root}/03_protenix_input_json' '${root}/04_protenix_output' '${root}/05_screening'`,
      `printf 'mock RF result\\n' > '${root}/01_rfdiffusion/design_001.pdb'`,
      `printf 'mock MPNN result\\n' > '${root}/02_proteinmpnn/design_001.fasta'`,
      `printf '{}\\n' > '${root}/03_protenix_input_json/design_001.json'`,
      `printf 'data_mock\\n' > '${cif}'`,
      `printf '# Synthetic screening report\\n' > '${report}'`,
      `printf 'rank,score\\n1,0.9\\n' > '${csv}'`,
      "printf 'mock NPU pipeline complete\\n'",
    ].join("; ");
  };

  journey.scenario({
    goal: "用户在已选 Ascend Runner 上请求抗体设计，Agent 按 Skill 走完准备、执行和报告交付。",
    preconditions: ["隔离产品栈运行 JiuwenSwarm", "NPU 设备、模型阶段由本用例的 Runner 代理确定性模拟",
      "真实 Runner 仍执行替代 Shell 并提交文件版本；此用例不声称推理正确"],
  });

  try {
    proxy = createServer(async (request, response) => {
      try {
        const path = request.url ?? "/";
        if (request.method === "GET" && path.startsWith("/npu/devices")) {
          response.writeHead(200, { "content-type": "application/json", date: new Date().toUTCString() });
          response.end(JSON.stringify(inventory));
          return;
        }
        if (request.method === "GET" && path === "/environments") {
          response.writeHead(200, { "content-type": "application/json", date: new Date().toUTCString() });
          response.end(JSON.stringify([mockEnvironment]));
          return;
        }
        if (request.method === "GET" && path === "/environment-revisions") {
          response.writeHead(200, { "content-type": "application/json", date: new Date().toUTCString() });
          response.end(JSON.stringify([mockRevision]));
          return;
        }
        if (request.method === "GET" && path === `/environment-revisions/${mockRevision.id}/snapshot`) {
          response.writeHead(200, { "content-type": "application/json", "content-length": environmentSnapshot.length });
          response.end(environmentSnapshot);
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        let body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (value !== undefined && !["host", "content-length", "transfer-encoding", "connection"].includes(key))
            headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        if (request.method === "POST" && ["/shell-executions", "/execute-shell"].includes(path)) {
          const job = JSON.parse(body.toString("utf8")) as { code: string; environmentId?: string;
            executionId: string; npuDevices?: number[] };
          expect(job.npuDevices, "the selected physical NPU must reach the Runner request").toEqual([4]);
          const phase = job.code.includes("validate_managed_environment.py") ? "probe"
            : job.code.includes("--prepare-only") ? "prepare"
              : job.code.includes("--validate-only") ? "validate" : "pipeline";
          if (phase !== "probe") expect(job.code).toContain("antibody-design/scripts/run_sandbox_pipeline.sh");
          intercepted.push({ code: job.code, executionId: job.executionId, npuDevices: job.npuDevices!, phase });
          // The real Runner still owns execution state, sandboxing, workspace commit and files.
          // Only the hardware-dependent command/card are replaced at this test boundary.
          job.code = mockCode(phase);
          delete job.npuDevices;
          delete job.environmentId;
          body = Buffer.from(JSON.stringify(job));
          const timestamp = headers.get(EXECUTION_TIMESTAMP_HEADER);
          if (!timestamp) throw new Error("signed Shell submission has no timestamp");
          expect(headers.get(EXECUTION_SIGNATURE_HEADER), "the product must sign the original Runner command")
            .toBe(createExecutionSignature(runnerToken, timestamp, Buffer.concat(chunks).toString("utf8")));
          headers.set(EXECUTION_SIGNATURE_HEADER, createExecutionSignature(runnerToken, timestamp, body.toString("utf8")));
        }
        const upstream = await fetch(new URL(path, runnerUrl!), {
          method: request.method, headers,
          ...(body.length ? { body } : {}), signal: AbortSignal.timeout(30_000),
        });
        let reply = Buffer.from(await upstream.arrayBuffer());
        if (upstream.ok && (path === "/execute-shell" || /^\/shell-executions\/[^/?]+(?:\?|$)/.test(path))) {
          const result = JSON.parse(reply.toString("utf8")) as {
            environmentRevisionId?: string; result?: { environmentRevisionId?: string } };
          if (result.environmentRevisionId) result.environmentRevisionId = mockRevision.id;
          if (result.result?.environmentRevisionId) result.result.environmentRevisionId = mockRevision.id;
          reply = Buffer.from(JSON.stringify(result));
        }
        const outgoing: Record<string, string> = {};
        for (const [key, value] of upstream.headers) {
          if (!["connection", "content-length", "content-encoding", "transfer-encoding"].includes(key)) outgoing[key] = value;
        }
        response.writeHead(upstream.status, outgoing);
        response.end(reply);
      } catch (error) {
        proxyErrors.push(String(error));
        if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
    await new Promise<void>((done) => proxy!.listen(0, "127.0.0.1", done));
    const port = (proxy.address() as AddressInfo).port;

    await journey.step("准备隔离的 mock NPU Runner", "远端 Runner 广告一张可用卡；产品存下选择，脚本仍会走真实 Shell Execution 协议。", async () => {
      const host = await api<{ id: string; status: string; error?: string }>("/api/remote-hosts", "POST", { alias: runName,
        connectionKind: "direct", endpoint: { host: "127.0.0.1", port, protocol: "http" }, token: runnerToken });
      hostId = host.id;
      expect(host.status, host.error).toBe("ready");
      await api(`/api/remote-hosts/${hostId}/runner/connect`, "POST", {});
      const selection = await api<{ devices: number[] }>(`/api/runners/${hostId}/npu-devices`, "PUT", { devices: [4] });
      expect(selection.devices).toEqual([4]);
    });

    const envResponse = await fetch(`http://127.0.0.1:${port}/environments`, { headers: { authorization: `Bearer ${runnerToken}` } });
    expect(envResponse.ok, "the isolated Runner must provide managed environments").toBe(true);
    const environments = await envResponse.json() as Array<{ id: string; language: string; status?: string }>;
    const environmentId = environments.find((environment) => environment.language === "python" && environment.status !== "failed")?.id;
    expect(environmentId, "a managed Python environment is required for the Skill journey").toBeTruthy();

    stub = await scriptedModel([
      { tool: "skill_tool", arguments: { skill_name: "antibody-design" } },
      { tool: "sync_remote_workspace", arguments: { runner_id: hostId, operation: "list" } },
      { tool: "sync_remote_workspace", arguments: { runner_id: hostId, operation: "push", paths: inputs } },
      { tool: "environment_list", arguments: { runner_id: hostId } },
      { tool: "run_shell", arguments: { runner_id: hostId, environment_id: environmentId,
        command: 'python "$SCIENCEDISCOVERY_SKILLS_DIR/antibody-design/scripts/validate_managed_environment.py" "$SCIENCEDISCOVERY_SKILLS_DIR/antibody-design/requirements.txt"' } },
      { tool: "run_shell", arguments: { runner_id: hostId, environment_id: environmentId,
        scriptPath, arguments: ["--prepare-only", "--config", "antibody_pipeline/config.json"], background: true } },
      { tool: "execution_status", arguments: () => ({
        execution_id: intercepted.find((entry) => entry.phase === "prepare")?.executionId, wait_ms: 30_000,
      }) },
      { tool: "run_shell", arguments: { runner_id: hostId, environment_id: environmentId,
        scriptPath, arguments: ["--validate-only", "--config", "antibody_pipeline/config.json"], wait_ms: 30_000 } },
      { tool: "run_shell", arguments: { runner_id: hostId, environment_id: environmentId,
        scriptPath, arguments: ["--config", "antibody_pipeline/config.json"], background: true } },
      { tool: "execution_status", arguments: () => ({
        execution_id: intercepted.find((entry) => entry.phase === "pipeline")?.executionId, wait_ms: 30_000,
      }) },
      { tool: "execution_logs", arguments: () => ({
        execution_id: intercepted.find((entry) => entry.phase === "pipeline")?.executionId,
      }) },
      { tool: "sync_remote_workspace", arguments: { runner_id: hostId, operation: "pull", paths: outputs } },
      ...outputs.map((path) => ({ tool: "declare_artifact", arguments: { path } })),
      { text: `${runName} finished: screening report, CSV and CIF are available as Artifacts.` },
    ]);
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow", model: {
      apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: runName,
    }, projectName: runName, sessionTitle: `${runName} session` });
    const sessionId = fixture.session.id;
    await api(`/api/sessions/${sessionId}`, "PATCH", { remoteRunnerHostIds: [hostId],
      skillSelectionMode: "selected", enabledSkillIds: ["antibody-design"] });
    for (const path of inputs) await api(`/api/sessions/${sessionId}/files`, "POST", { path,
      content: path.endsWith(".json") ? JSON.stringify({ workspace: "antibody_pipeline", run_name: runName, npus: "0" })
        : "ATOM      1  CA  ALA B  45       0.000   0.000   0.000  1.00  0.00           C\n" });

    await journey.step("用户请求 Agent 完成抗体设计", "JiuwenSwarm 加载仓库 Skill，经受控 Runner 提交准备、验证和一次 pipeline。", async () => {
      await openProjectSession(page, fixture!);
      const run = await sendUserMessage(page, sessionId, `Use antibody-design on the selected Ascend Runner for ${runName}; deliver the report, CSV and CIF.`);
      const terminal = await waitForRunTerminal(page, sessionId, run.id, 180_000);
      expect(terminal.status, terminal.error).toBe("completed");
      await expect(page.getByText(`${runName} finished:`, { exact: false }).first()).toBeVisible();
      const events = await api<Array<{ event: { type: string; trace?: {
        name?: string; output?: string; outputStream?: string; status?: string; summary?: string } } }>>(
        `/api/sessions/${sessionId}/runs/${run.id}/events?after=0`);
      const calls = events.filter(({ event }) => event.type === "tool.started").map(({ event }) => event.trace?.name);
      for (const name of ["skill_tool", "sync_remote_workspace", "environment_list", "run_shell", "execution_status", "declare_artifact"])
        expect(calls, `${name} must occur in the product Agent trace`).toContain(name);
      const failedTools = await Promise.all(events
        .filter(({ event }) => event.type === "tool.completed" && event.trace?.status === "failed")
        .map(async ({ event }) => ({ name: event.trace?.name, summary: event.trace?.summary,
          output: event.trace?.output?.slice(0, 300),
          stream: event.trace?.outputStream ? JSON.stringify(await api(
            `/api/sessions/${sessionId}/runs/${run.id}/streams/${event.trace.outputStream}/events?after=0`)).slice(0, 700) : undefined })));
      expect({ failedTools, proxyErrors }, "a scripted final answer cannot hide a failed tool or proxy error")
        .toEqual({ failedTools: [], proxyErrors: [] });
      expect(intercepted.map((item) => item.phase)).toEqual(["probe", "prepare", "validate", "pipeline"]);
      expect(intercepted.filter((item) => item.phase === "pipeline")).toHaveLength(1);
      expect(proxyErrors).toEqual([]);
      const activity = await api<{ executions: Array<{ id: string; runnerId: string; state: string }> }>(
        `/api/sessions/${sessionId}/agent-activity`);
      for (const phase of ["prepare", "pipeline"]) {
        const executionId = intercepted.find((item) => item.phase === phase)?.executionId;
        expect(activity.executions.find((item) => item.id === executionId), `${phase} needs a confirmed terminal receipt`)
          .toMatchObject({ runnerId: hostId, state: "completed" });
      }
    });

    await journey.step("检查真实文件回传与用户可见产物", "报告、CSV、CIF 在远端和当前会话都存在，并由 Agent 声明为 Artifact。", async () => {
      const files = await api<Array<{ path: string; size: number }>>(`/api/sessions/${sessionId}/files`);
      const artifacts = await api<Array<{ origin: string; originMeta?: { declaredPath?: string } }>>(`/api/sessions/${sessionId}/artifacts`);
      const remote = await api<{ files: Array<{ path: string; size: number }> }>(`/api/runners/${hostId}/workspaces/${sessionId}/files`);
      for (const path of outputs) {
        expect(files.some((item) => item.path === path && item.size > 0), `local ${path}`).toBe(true);
        expect(remote.files.some((item) => item.path === path && item.size > 0), `remote ${path}`).toBe(true);
        expect(artifacts.some((item) => item.origin === "llm_declared" && item.originMeta?.declaredPath === path),
          `Artifact ${path}`).toBe(true);
      }
      const tree = await artifactTree(page);
      await expect(tree.artifactCount).toHaveText(String(artifacts.length));
    });
  } finally {
    if (fixture) await cleanupJourney(page, fixture);
    await stub?.stop();
    if (hostId) await page.request.delete(`${apiBaseUrl()}/api/remote-hosts/${hostId}`, { headers: authorizationHeader() }).catch(() => undefined);
    if (proxy) await new Promise<void>((done) => { proxy!.close(() => done()); proxy!.closeAllConnections(); });
  }
});

});
