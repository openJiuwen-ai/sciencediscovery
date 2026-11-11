// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import type { AgentShellExecution, ShellExecutionResult } from "@sciencediscovery/schema";
import { createWorkspaceTools } from "./workspace.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
const diagnostic = {
  code: "COMMAND_NOT_FOUND" as const, command: "missing_probe",
  instruction: "Inspect check_runner shell.utilities and use an available command or Python equivalent; do not retry the same command unchanged.",
};

for (const entry of ["synchronous", "managed immediate", "managed wait", "status", "status list", "cancel"] as const) {
  test(`Shell diagnostic reaches the model through ${entry} without exposing extra fields`, async () => {
    const result = {
      executionId: "probe", exitCode: 127, stdout: "", stderr: "bash: missing_probe: command not found\n",
      diagnostic: { ...diagnostic, authorization: "diagnostic-secret" },
      environmentVariables: { TOKEN: "environment-secret" },
    } as unknown as ShellExecutionResult;
    const execution = { id: "probe", state: "failed", result } as AgentShellExecution;
    const pending = { ...execution, state: "running", result: undefined } as AgentShellExecution;
    const tools = createWorkspaceTools(process.cwd(), {
      enabledConnectorIds: [], executePython: async () => { throw new Error("unused"); },
      executeShell: async () => result,
      ...(entry !== "synchronous" ? { shellExecutions: {
        start: async () => entry === "managed wait" ? pending : execution,
        wait: async () => execution, get: async () => execution, list: () => [execution],
        logs: async () => { throw new Error("unused"); }, cancel: async () => execution,
      } } : {}),
    });
    const name = entry.startsWith("status") ? "execution_status" : entry === "cancel" ? "execution_cancel" : "run_shell";
    const params = name === "run_shell" ? { command: "missing_probe", wait_ms: entry === "managed wait" ? 1 : undefined }
      : entry === "status list" ? {} : { execution_id: "probe" };
    const response = await tools.find(tool => tool.name === name)!.execute("call", params);
    const text = response.content[0]!.text;
    const metadata = JSON.parse(text.split("\n")[0]!);
    const view = entry === "status list" ? metadata.executions[0] : metadata;
    assert.deepEqual(view.diagnostic, diagnostic);
    assert.doesNotMatch(JSON.stringify(response), /diagnostic-secret|environment-secret|environmentVariables/);
    if (name === "run_shell") assert.match(text, /bash: missing_probe: command not found/);
    else assert.doesNotMatch(text, /"stdout"|"stderr"/);
  });
}

test("Shell model view does not invent a diagnostic for an arbitrary exit 127", async () => {
  const tools = createWorkspaceTools(process.cwd(), {
    enabledConnectorIds: [], executePython: async () => { throw new Error("unused"); },
    executeShell: async () => ({ executionId: "probe", exitCode: 127, stdout: "command not found", stderr: "" }) as ShellExecutionResult,
  });
  const response = await tools.find(tool => tool.name === "run_shell")!.execute("call", { command: "exit 127" });
  assert.equal(JSON.parse(response.content[0]!.text.split("\n")[0]!).diagnostic, undefined);
});
