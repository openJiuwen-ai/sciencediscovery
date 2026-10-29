// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import type { AgentShellExecution, ShellRecoveryOptions } from "@sciencediscovery/schema";
import { createWorkspaceTools } from "./workspace.js";

test("run_shell forwards explicit recovery through the existing managed execution path; status never submits", async () => {
  let submissions = 0;
  const context = { parentExecutionId: "parent", recoveryPointId: "resume", manifestDigest: `sha256:${"a".repeat(64)}` as const, attemptToken: "one-attempt" };
  const job = { id: "child", state: "failed", recoveryContext: context,
    recovery: { schemaVersion: 1, capability: "unsupported", reason: "NO_CHECKPOINT" } } as AgentShellExecution;
  let options: ShellRecoveryOptions | undefined;
  const tools = createWorkspaceTools(process.cwd(), { enabledConnectorIds: [],
    executePython: async () => { throw new Error("must not execute Python"); },
    executeShell: async () => { throw new Error("must not use unmanaged execution"); },
    shellExecutions: {
      start: async (code, input) => { submissions++; assert.equal(code, "python3 recovery-fixture.py resume"); options = input; return job; },
      get: async () => job, wait: async () => job, list: () => [job], cancel: async () => job,
      logs: async () => ({ chunks: [], nextCursor: 0, retentionTruncated: false, truncated: false }),
    },
  });
  const shell = tools.find(tool => tool.name === "run_shell")!;
  await shell.execute("resume", { command: "python3 recovery-fixture.py resume", recovery_metadata_path: "recovery.json", recovery_context: context, background: true });
  assert.deepEqual(options, { environmentId: undefined, cwd: undefined, recoveryMetadataPath: "recovery.json", recoveryContext: context });
  const status = tools.find(tool => tool.name === "execution_status")!;
  assert.deepEqual((await status.execute("inspect", { execution_id: "child" })).details, job);
  assert.deepEqual((await status.execute("list", {})).details, [job]);
  assert.equal(submissions, 1);
});

test("recovery options cannot silently fall back to an unmanaged shell", async () => {
  let calls = 0;
  const tools = createWorkspaceTools(process.cwd(), { enabledConnectorIds: [], executePython: async () => { throw new Error("unused"); },
    executeShell: async () => { calls++; throw new Error("must not execute"); } });
  await assert.rejects(tools.find(tool => tool.name === "run_shell")!.execute("resume", {
    command: "echo hello", recovery_metadata_path: "recovery.json",
  }), /Managed Shell Execution is unavailable/);
  assert.equal(calls, 0);
});
