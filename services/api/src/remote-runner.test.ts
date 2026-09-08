// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type { RunnerClient } from "@sciencediscovery/executor";
import type { RemoteWorkspaceFile, RemoteWorkspaceSnapshot } from "@sciencediscovery/schema";

import { remoteWorkspaceKey, syncRemoteWorkspace } from "./remote-runner.js";
import { SessionStore } from "./store.js";

function snapshots(remote: Map<string, Buffer>, expectedWorkspace: string) {
  const captured = new Map<string, Map<string, Buffer>>();
  return {
    snapshotRemoteWorkspace: async (workspace: string, paths: string[]): Promise<RemoteWorkspaceSnapshot> => {
      assert.equal(workspace, expectedWorkspace);
      const id = randomUUID();
      const copy = new Map([...remote].filter(([path]) => paths.some((selected) => path === selected || path.startsWith(`${selected}/`)))
        .map(([path, bytes]) => [path, Buffer.from(bytes)]));
      captured.set(id, copy);
      return { id, workspace, capturedAt: new Date().toISOString(), files: [...copy].map(([path, bytes]) => ({
        path, size: bytes.length, executable: 0, sha256: createHash("sha256").update(bytes).digest("hex"),
      })) };
    },
    streamWorkspaceSnapshot: async (snapshot: RemoteWorkspaceSnapshot, path: string) => (async function* () { yield captured.get(snapshot.id)!.get(path)!; })(),
  };
}

test("explicit remote workspace push and pull preserve independent files and records", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `remote-workspace-sync-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = new SessionStore(root);
  await store.load();
  const host = await store.registerRemoteHost({ alias: "linux-runner", capabilities: {
    conda: false,
    containerRuntimes: [],
    cpuCores: 4,
    cuda: null,
    gpu: null,
    memoryBytes: 8 * 1024 ** 3,
    modules: false,
    nodeVersion: null,
    platform: "Linux",
    probedAt: new Date().toISOString(),
    runnerCommandAvailable: true,
    scratchPaths: ["/tmp"],
    slurm: false,
  } });
  // Both main and child workspace operations use the independent Session
  // selection even when the Project has no remote defaults.
  const project = await store.createProject("Remote", {}, []);
  const session = await store.createSession(
    project.id,
    "Remote Session",
    {},
    { remoteRunnerHostIds: [host.id] },
    { allowUnconfiguredModel: true },
  );
  const childRoot = store.agentWorkspacePath(session.id, "child-a");
  await mkdir(childRoot, { recursive: true });
  const childKey = remoteWorkspaceKey(project.id, session.id, undefined, "child-a");
  assert.notEqual(childKey, remoteWorkspaceKey(project.id, session.id, undefined, "child-b"));
  const childRunner = {
    ...snapshots(new Map([["child.txt", Buffer.from("child")]]), childKey),
    listRemoteWorkspaceFiles: async (key: string) => {
      assert.equal(key, childKey);
      return [{ path: "child.txt", modifiedAt: new Date().toISOString(), size: 5 }];
    },
    readRemoteWorkspaceFile: async (key: string) => { assert.equal(key, childKey); return Buffer.from("child"); },
  } as unknown as RunnerClient;
  const childResult = await syncRemoteWorkspace({ hostId: host.id, input: { direction: "pull", paths: ["child.txt"] }, runnerClient: childRunner, sessionId: session.id, store, agentId: "child-a", workspaceRoot: childRoot });
  assert.equal(childResult.record.agentId, "child-a");
  assert.equal(await readFile(resolve(childRoot, "child.txt"), "utf8"), "child");
  assert.equal(store.listArtifacts(session.id).length, 0, "pull does not implicitly declare an Artifact");
  assert.ok(store.getWorkspaceFileProvenance(session.id, "subagents/child-a/child.txt")?.currentRevision.originMeta?.transferId);
  assert.ok(store.getWorkspaceFileProvenance(session.id, "subagents/child-a/child.txt")?.currentRevision.originMeta?.sourceSnapshotId);
  await assert.rejects(readFile(resolve(store.workspacePath(session.id), "child.txt")), { code: "ENOENT" });
  const workspaceRoot = store.workspacePath(session.id);
  await writeFile(resolve(workspaceRoot, "input.txt"), "local-input");

  const remote = new Map<string, Buffer>();
  const runnerClient = {
    ...snapshots(remote, remoteWorkspaceKey(project.id, session.id)),
    listRemoteWorkspaceFiles: async (key: string): Promise<RemoteWorkspaceFile[]> => {
      assert.equal(key, remoteWorkspaceKey(project.id, session.id));
      await writeFile(resolve(workspaceRoot, "input.txt"), "next local execution");
      return [...remote.entries()].map(([path, bytes]) => ({
        modifiedAt: "2026-08-31T00:00:00.000Z",
        path,
        size: bytes.length,
      }));
    },
    readRemoteWorkspaceFile: async (_key: string, path: string) => remote.get(path)!,
    writeRemoteWorkspaceFile: async (_key: string, path: string, bytes: Uint8Array, conflict: "overwrite" | "reject") => {
      if (conflict === "reject" && remote.has(path)) throw new Error("collision");
      remote.set(path, Buffer.from(bytes));
      return { path, size: bytes.length };
    },
  } as unknown as RunnerClient;

  const pushed = await syncRemoteWorkspace({
    hostId: host.id,
    input: { direction: "push", paths: ["input.txt"] },
    runnerClient,
    sessionId: session.id,
    store,
  });
  assert.equal(remote.get("input.txt")?.toString("utf8"), "local-input");
  assert.equal(pushed.record.direction, "push");
  const outside = resolve(root, "outside");
  await mkdir(outside);
  await symlink(outside, resolve(workspaceRoot, "escape"));
  remote.set("escape/output.txt", Buffer.from("must-not-escape"));
  await assert.rejects(syncRemoteWorkspace({
    hostId: host.id,
    input: { direction: "pull", paths: ["escape"] },
    runnerClient,
    sessionId: session.id,
    store,
  }), /real directory/);
  await assert.rejects(readFile(resolve(outside, "output.txt")), { code: "ENOENT" });
  remote.set("results/output.txt", Buffer.from("remote-output"));
  const stableStream = runnerClient.streamWorkspaceSnapshot.bind(runnerClient);
  runnerClient.streamWorkspaceSnapshot = async (snapshot, path, signal) => {
    remote.set(path, Buffer.from("next remote execution"));
    return stableStream(snapshot, path, signal);
  };

  const pulled = await syncRemoteWorkspace({
    hostId: host.id,
    input: { direction: "pull", paths: ["results"] },
    runnerClient,
    sessionId: session.id,
    store,
  });
  assert.deepEqual(pulled.files, ["results/output.txt"]);
  assert.equal(await readFile(resolve(workspaceRoot, "results", "output.txt"), "utf8"), "remote-output");
  runnerClient.streamWorkspaceSnapshot = stableStream;
  assert.deepEqual(store.listRemoteWorkspaceSyncs(session.id).filter((record) => !record.agentId).map((record) => [record.direction, record.status]), [
    ["pull", "completed"],
    ["pull", "failed"],
    ["push", "completed"],
  ]);

  // A local execution creates this file after preflight, while download waits.
  // reject must arbitrate at the final write, not just at the initial check.
  remote.set("race.txt", Buffer.from("remote"));
  const raceDestination = resolve(workspaceRoot, "race.txt");
  const racingRunner = {
    ...runnerClient,
    streamWorkspaceSnapshot: async (snapshot: RemoteWorkspaceSnapshot, path: string) => {
      await writeFile(raceDestination, "local result");
      return runnerClient.streamWorkspaceSnapshot(snapshot, path);
    },
  } as unknown as RunnerClient;
  await assert.rejects(syncRemoteWorkspace({
    hostId: host.id, input: { direction: "pull", paths: ["race.txt"], conflict: "reject" },
    runnerClient: racingRunner, sessionId: session.id, store,
  }), { code: "CONFLICT" });
  assert.equal(await readFile(raceDestination, "utf8"), "local result");
  await syncRemoteWorkspace({
    hostId: host.id, input: { direction: "pull", paths: ["race.txt"], conflict: "overwrite" },
    runnerClient, sessionId: session.id, store,
  });
  assert.equal(await readFile(raceDestination, "utf8"), "remote");
  remote.set("parallel.txt", Buffer.from("parallel-result"));
  const pull = () => syncRemoteWorkspace({
    hostId: host.id, input: { direction: "pull" as const, paths: ["parallel.txt"], conflict: "reject" as const },
    runnerClient, sessionId: session.id, store,
  });
  const competing = await Promise.allSettled([pull(), pull()]);
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
  const loser = competing.find((result) => result.status === "rejected");
  assert.equal(loser?.status === "rejected" && loser.reason.code, "CONFLICT");
  assert.equal((await readdir(workspaceRoot)).some((name) => name.includes(".transfer-")), false);
});
