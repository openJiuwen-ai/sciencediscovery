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
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { PermissionEpoch } from "@science-agent/schema";

import { executePython, executeShell } from "./executor.js";
import { SessionEnvProfileStore, sedimentableVariables } from "./session-env-profile.js";
import { ShellSessionManager } from "./shell-session-manager.js";

const BWRAP_PATH = process.env.SCIENCE_AGENT_BWRAP_PATH?.trim() || "bwrap";

function epoch(id = "epoch-test", sessionId = "session-test"): PermissionEpoch {
  return {
    createdAt: new Date().toISOString(),
    environmentRevisionId: "rev-python",
    id,
    mounts: [{ mode: "read-write", source: "workspace" }],
    networkPolicy: "none",
    reason: "test",
    secretRefs: [],
    sessionId,
  };
}

async function fixture(context: TestContext) {
  const dataDir = resolve(process.cwd(), ".tmp", `shell-session-${process.pid}-${Date.now()}-${Math.random()}`);
  const workspaceRoot = resolve(dataDir, "projects", "project", "sessions", "session", "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const profiles = new SessionEnvProfileStore();
  const config = { bwrapPath: BWRAP_PATH, dataDir, execTimeoutMs: 60_000, maxOutputBytes: 1_000_000, maxWorkspaceBytes: 10_737_418_240 };
  const manager = new ShellSessionManager({ ...config, idleTimeoutMs: 0 }, profiles);
  context.after(() => manager.close());
  return { config, dataDir, manager, profiles, workspaceRoot };
}

test("a persistent shell session keeps exports and cwd across run_shell calls", async (context) => {
  const { manager, workspaceRoot } = await fixture(context);
  const first = await manager.execute({
    agentId: "main",
    code: "export FOO=bar\nmkdir -p subdir\ncd subdir\necho ready",
    executionId: "shell-one", kernelMode: "persistent", permissionEpoch: epoch(), workspaceRoot,
  });
  assert.equal(first.exitCode, 0);
  assert.equal(first.kernelMode, "persistent");
  assert.equal(first.stdout.trim(), "ready");
  assert.equal(first.workingDirectory, "/workspace/subdir");
  assert.equal(first.environmentVariables.FOO, "bar");

  const second = await manager.execute({
    agentId: "main",
    code: "echo \"$FOO in $(pwd)\"",
    executionId: "shell-two", kernelMode: "persistent", permissionEpoch: epoch(), workspaceRoot,
  });
  assert.equal(second.kernelId, first.kernelId);
  assert.equal(second.stdout.trim(), "bar in /workspace/subdir");

  // A failing command reports its exit code without killing the session.
  const failing = await manager.execute({
    agentId: "main",
    code: "false",
    executionId: "shell-three", kernelMode: "persistent", permissionEpoch: epoch(), workspaceRoot,
  });
  assert.equal(failing.exitCode, 1);
  const survived = await manager.execute({
    agentId: "main",
    code: "echo $FOO",
    executionId: "shell-four", kernelMode: "persistent", permissionEpoch: epoch(), workspaceRoot,
  });
  assert.equal(survived.kernelId, first.kernelId);
  assert.equal(survived.stdout.trim(), "bar");
});

test("persistent shells isolate Main, sibling Subagents, and Sessions while preserving each Agent state", async (context) => {
  const { dataDir, manager, profiles, workspaceRoot } = await fixture(context);
  const firstSubagentRoot = resolve(workspaceRoot, "subagents", "subagent-1");
  const secondSubagentRoot = resolve(workspaceRoot, "subagents", "subagent-2");
  const otherSessionRoot = resolve(dataDir, "projects", "project", "sessions", "session-other", "workspace");
  await Promise.all([
    mkdir(firstSubagentRoot, { recursive: true }),
    mkdir(secondSubagentRoot, { recursive: true }),
    mkdir(otherSessionRoot, { recursive: true }),
  ]);

  const main = await manager.execute({
    agentId: "main",
    code: "export OWNER=main\nprintf 'PARENT_ONLY\\n' > isolation-probe.txt",
    executionId: "main-isolation",
    kernelMode: "persistent",
    permissionEpoch: epoch(),
    workspaceRoot,
  });
  const firstSubagent = await manager.execute({
    agentId: "subagent:subagent-1",
    code: "printf '%s\\n' \"${OWNER:-SUBAGENT_ONLY}\" > isolation-probe.txt",
    executionId: "subagent-one-isolation",
    kernelMode: "persistent",
    permissionEpoch: epoch(),
    readOnlyWorkspaceRoot: workspaceRoot,
    workspaceRoot: firstSubagentRoot,
  });
  const secondSubagent = await manager.execute({
    agentId: "subagent:subagent-2",
    code: "export OWNER=subagent-two\nprintf 'SECOND_SUBAGENT\\n' > isolation-probe.txt",
    executionId: "subagent-two-isolation",
    kernelMode: "persistent",
    permissionEpoch: epoch(),
    readOnlyWorkspaceRoot: workspaceRoot,
    workspaceRoot: secondSubagentRoot,
  });
  const otherSession = await manager.execute({
    agentId: "main",
    code: "printf 'OTHER_SESSION\\n' > isolation-probe.txt",
    executionId: "other-session-isolation",
    kernelMode: "persistent",
    permissionEpoch: epoch("epoch-other", "session-other"),
    workspaceRoot: otherSessionRoot,
  });

  assert.equal(await readFile(resolve(workspaceRoot, "isolation-probe.txt"), "utf8"), "PARENT_ONLY\n");
  assert.equal(await readFile(resolve(firstSubagentRoot, "isolation-probe.txt"), "utf8"), "SUBAGENT_ONLY\n");
  assert.equal(await readFile(resolve(secondSubagentRoot, "isolation-probe.txt"), "utf8"), "SECOND_SUBAGENT\n");
  assert.equal(await readFile(resolve(otherSessionRoot, "isolation-probe.txt"), "utf8"), "OTHER_SESSION\n");
  assert.deepEqual(main.createdFiles, ["isolation-probe.txt"]);
  assert.deepEqual(firstSubagent.createdFiles, ["isolation-probe.txt"]);
  assert.deepEqual(secondSubagent.createdFiles, ["isolation-probe.txt"]);
  assert.deepEqual(otherSession.createdFiles, ["isolation-probe.txt"]);
  assert.equal(new Set([main.kernelId, firstSubagent.kernelId, secondSubagent.kernelId, otherSession.kernelId]).size, 4);
  assert.equal(profiles.get("session-test", "main", "epoch-test")?.variables.OWNER, "main");
  assert.equal(profiles.get("session-test", "subagent:subagent-1", "epoch-test")?.variables.OWNER, undefined);
  assert.equal(profiles.get("session-test", "subagent:subagent-2", "epoch-test")?.variables.OWNER, "subagent-two");
});

test("concurrent calls for one Session-Agent create one shell and execute in submission order", async (context) => {
  const { manager, workspaceRoot } = await fixture(context);
  const first = manager.execute({
    agentId: "main",
    code: "sleep 0.15\nexport ORDERED=first\necho first",
    executionId: "ordered-one",
    kernelMode: "persistent",
    permissionEpoch: epoch(),
    workspaceRoot,
  });
  const second = manager.execute({
    agentId: "main",
    code: "echo \"${ORDERED:-missing}\"",
    executionId: "ordered-two",
    kernelMode: "persistent",
    permissionEpoch: epoch(),
    workspaceRoot,
  });

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.kernelId, secondResult.kernelId);
  assert.equal(secondResult.stdout.trim(), "first");
  assert.equal(manager.list().length, 1);
});

test("a Session-Agent identity rejects reuse with different workspace mounts", async (context) => {
  const { manager, workspaceRoot } = await fixture(context);
  const differentRoot = resolve(workspaceRoot, "different");
  await mkdir(differentRoot, { recursive: true });
  await manager.execute({
    agentId: "main",
    code: "echo ready",
    executionId: "mount-one",
    kernelMode: "persistent",
    permissionEpoch: epoch(),
    workspaceRoot,
  });
  await assert.rejects(manager.execute({
    agentId: "main",
    code: "echo wrong",
    executionId: "mount-two",
    kernelMode: "persistent",
    permissionEpoch: epoch(),
    workspaceRoot: differentRoot,
  }), /cannot be reused with different workspace mounts/);
});

test("shell exports sediment into the session env profile and reach ephemeral python and shell", async (context) => {
  const { config, manager, profiles, workspaceRoot } = await fixture(context);
  const shell = await manager.execute({
    agentId: "main",
    code: "export FOO=from-shell\nexport LD_PRELOAD=/tmp/evil.so\nmkdir -p nested\ncd nested",
    executionId: "profile-shell", kernelMode: "persistent", permissionEpoch: epoch(), workspaceRoot,
  });
  // Provenance keeps the real shell env (including the blocked key)...
  assert.equal(shell.environmentVariables.LD_PRELOAD, "/tmp/evil.so");
  // ...while the injectable profile applies the whitelist policy.
  const profile = profiles.get("session-test", "main", "epoch-test");
  assert.ok(profile);
  assert.equal(profile.variables.FOO, "from-shell");
  assert.equal(profile.variables.LD_PRELOAD, undefined);
  assert.equal(profile.variables.PATH, undefined);
  assert.equal(profile.cwd, "/workspace/nested");

  const python = await executePython(config, {
    agentId: "main",
    code: "import os\nprint(os.environ.get('FOO'))\nprint(os.environ.get('LD_PRELOAD'))\nprint(os.getcwd())",
    executionId: "profile-python", language: "python", permissionEpoch: epoch(), workspaceRoot,
  }, undefined, undefined, profile);
  assert.equal(python.exitCode, 0);
  assert.deepEqual(python.stdout.trim().split("\n"), ["from-shell", "None", "/workspace/nested"]);
  assert.equal(python.environmentVariables.FOO, "from-shell");
  assert.equal(python.environmentVariables.LD_PRELOAD, undefined);
  assert.equal(python.workingDirectory, "/workspace/nested");

  const ephemeralShell = await executeShell(config, {
    agentId: "main",
    code: "echo \"$FOO in $(pwd)\"",
    executionId: "profile-eph-shell", permissionEpoch: epoch(), workspaceRoot,
  }, undefined, profile);
  assert.equal(ephemeralShell.stdout.trim(), "from-shell in /workspace/nested");

  // Executions with different effective envs stay distinguishable.
  const plain = await executePython(config, {
    agentId: "main",
    code: "print('no profile')",
    executionId: "no-profile-python", language: "python", permissionEpoch: epoch(), workspaceRoot,
  });
  assert.notDeepEqual(plain.environmentVariables, python.environmentVariables);
  assert.equal(plain.workingDirectory, "/workspace");
});

test("an idle persistent shell session is released with an observable reason and its profile cleared", async (context) => {
  const { manager, profiles, workspaceRoot } = await fixture(context);
  const first = await manager.execute({
    agentId: "main",
    code: "export FOO=bar", executionId: "idle-one", kernelIdleTimeoutMs: 250,
    kernelMode: "persistent", permissionEpoch: epoch(), workspaceRoot,
  });
  assert.ok(profiles.get("session-test", "main", "epoch-test"));
  assert.ok(first.kernelId.startsWith("shell-"));
  const expiry = Date.now() + 5_000;
  while (manager.list().length && Date.now() < expiry) await delay(50);
  assert.deepEqual(manager.list(), []);
  assert.equal(profiles.get("session-test", "main", "epoch-test"), undefined);
  const second = await manager.execute({
    agentId: "main",
    code: "echo \"FOO=$FOO\"", executionId: "idle-two", kernelIdleTimeoutMs: 250,
    kernelMode: "persistent", permissionEpoch: epoch(), workspaceRoot,
  });
  assert.notEqual(second.kernelId, first.kernelId);
  assert.equal(second.stdout.trim(), "FOO=");
  assert.match(second.memoryStateLost ?? "", /idle timeout/);
});

test("shell sessions honour permission boundaries and teardown", async (context) => {
  const { manager, profiles, workspaceRoot } = await fixture(context);
  await assert.rejects(manager.execute({
    agentId: "main",
    code: "echo no", executionId: "once-shell", kernelMode: "persistent",
    permissionEpoch: { ...epoch(), executeGrantScope: "once" }, workspaceRoot,
  }), /once-scoped/);

  const first = await manager.execute({
    agentId: "main",
    code: "export FOO=bar", executionId: "boundary-one", kernelMode: "persistent",
    permissionEpoch: epoch(), workspaceRoot,
  });
  // An epoch change stops the previous session and reports the loss.
  const changed = await manager.execute({
    agentId: "main",
    code: "echo \"FOO=$FOO\"", executionId: "boundary-two", kernelMode: "persistent",
    permissionEpoch: epoch("epoch-next"), workspaceRoot,
  });
  assert.notEqual(changed.kernelId, first.kernelId);
  assert.equal(changed.stdout.trim(), "FOO=");
  assert.match(changed.memoryStateLost ?? "", /Permission Epoch changed/);

  assert.equal(await manager.teardownSession("session-test", "Session was archived"), 1);
  assert.deepEqual(manager.list(), []);
  assert.equal(profiles.get("session-test", "main", "epoch-next"), undefined);
});

test("user exit ends the session gracefully and the next call starts fresh", async (context) => {
  const { manager, workspaceRoot } = await fixture(context);
  const first = await manager.execute({
    agentId: "main",
    code: "export FOO=bar\nexit 7", executionId: "exit-one", kernelMode: "persistent",
    permissionEpoch: epoch(), workspaceRoot,
  });
  assert.equal(first.exitCode, 7);
  const second = await manager.execute({
    agentId: "main",
    code: "echo \"FOO=$FOO\"", executionId: "exit-two", kernelMode: "persistent",
    permissionEpoch: epoch(), workspaceRoot,
  });
  assert.notEqual(second.kernelId, first.kernelId);
  assert.equal(second.stdout.trim(), "FOO=");
  assert.match(second.memoryStateLost ?? "", /exited/);
});

test("sedimentable variable policy filters reserved, blocked, and malformed keys", () => {
  const variables = sedimentableVariables({
    BASH_ENV: "/tmp/x",
    FOO: "ok",
    HOME: "/tmp",
    LD_LIBRARY_PATH: "/lib",
    "bad-name": "no",
    PATH: "/usr/bin",
    PYTHONSTARTUP: "/tmp/s.py",
    SAFE_TOKEN: "123",
  });
  assert.deepEqual(variables, { FOO: "ok", SAFE_TOKEN: "123" });
});
