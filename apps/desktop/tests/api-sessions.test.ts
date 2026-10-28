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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import * as sessions from "../src/api/sessions.js";
import { StubClient, json, split } from "./api-stub.js";

type CreateSessionBody = Parameters<typeof sessions.createSession>[2];
type UpdateSessionBody = Parameters<typeof sessions.updateSession>[2];

describe("project and session reads", () => {
  it("lists projects and creates one with the name in the body", async () => {
    const stub = new StubClient().reply([]).reply({ firstSession: {}, project: {} });
    const client = stub.asClient();

    await sessions.listProjects(client);
    await sessions.createProject(client, "材料筛选");

    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0]!.path, "/api/projects");
    assert.equal(stub.calls[0]!.init.method, undefined);
    assert.equal(stub.calls[1]!.path, "/api/projects");
    assert.equal(stub.calls[1]!.init.method, "POST");
    assert.deepEqual(json(stub.calls[1]!), { name: "材料筛选" });
  });

  it("names the project and the list state, defaulting to active", async () => {
    const stub = new StubClient().reply([]).reply([]);
    const client = stub.asClient();

    await sessions.listSessions(client, "project/one");
    await sessions.listSessions(client, "project/one", "archived");

    const first = split(stub.calls[0]!);
    assert.equal(first.pathname, "/api/projects/project%2Fone/sessions");
    assert.equal(first.query.get("state"), "active");
    assert.equal(split(stub.calls[1]!).query.get("state"), "archived");
  });

  it("creates a session by posting the body it was handed", async () => {
    const stub = new StubClient().reply({});
    const body = { modelId: "model/one", title: "新会话" } as unknown as CreateSessionBody;

    await sessions.createSession(stub.asClient(), "project/one", body);

    assert.equal(stub.calls[0]!.path, "/api/projects/project%2Fone/sessions");
    assert.equal(stub.calls[0]!.init.method, "POST");
    assert.deepEqual(json(stub.calls[0]!), body);
  });

  it("reads one session with GET and updates it with PATCH", async () => {
    const stub = new StubClient().reply({}).reply({});
    const body = { title: "改个名字" } as unknown as UpdateSessionBody;

    await sessions.getSession(stub.asClient(), "session/one");
    await sessions.updateSession(stub.asClient(), "session/one", body);

    assert.equal(stub.calls[0]!.path, "/api/sessions/session%2Fone");
    assert.equal(stub.calls[0]!.init.method, undefined);
    assert.equal(stub.calls[1]!.path, "/api/sessions/session%2Fone");
    assert.equal(stub.calls[1]!.init.method, "PATCH");
    assert.deepEqual(json(stub.calls[1]!), body);
  });

  it("reaches runs and subagents through the session", async () => {
    const stub = new StubClient().reply([]).reply([]);
    const client = stub.asClient();

    await sessions.listRuns(client, "session/one");
    await sessions.listSubagents(client, "session/one");

    assert.equal(stub.calls[0]!.path, "/api/sessions/session%2Fone/runs");
    assert.equal(stub.calls[1]!.path, "/api/sessions/session%2Fone/subagents");
  });
});

describe("stopping a run", () => {
  it("cancels a named run or asks for the current one", async () => {
    const stub = new StubClient().reply({}).reply({ cancelled: true });
    const client = stub.asClient();

    await sessions.cancelRun(client, "session/one", "run/one");
    await sessions.cancelCurrentRun(client, "session/one");

    assert.equal(stub.calls[0]!.path, "/api/sessions/session%2Fone/runs/run%2Fone/cancel");
    assert.equal(stub.calls[0]!.init.method, "POST");
    assert.equal(stub.calls[1]!.path, "/api/sessions/session%2Fone/runs/current/cancel");
    assert.equal(stub.calls[1]!.init.method, "POST");
  });
});

describe("workspace files and artifacts", () => {
  it("reads the three lists from their own routes", async () => {
    const stub = new StubClient().reply([]).reply([]).reply([]);
    const client = stub.asClient();

    await sessions.listWorkspaceFiles(client, "session/one");
    await sessions.listArtifacts(client, "session/one");
    await sessions.listArtifactOutputs(client, "session/one");

    assert.equal(stub.calls[0]!.path, "/api/sessions/session%2Fone/files");
    assert.equal(stub.calls[1]!.path, "/api/sessions/session%2Fone/artifacts");
    assert.equal(stub.calls[2]!.path, "/api/sessions/session%2Fone/artifact-outputs");
  });

  it("reads file and artifact bytes as text and encodes both path and id", async () => {
    const stub = new StubClient().stream("file body").stream("artifact body");
    const client = stub.asClient();

    const file = await sessions.readWorkspaceFile(client, "session/one", "data/a b.txt");
    const artifact = await sessions.readArtifactVersion(client, "session/one", "version/one");

    const fileCall = split(stub.calls[0]!);
    assert.equal(fileCall.pathname, "/api/sessions/session%2Fone/file");
    assert.equal(fileCall.query.get("path"), "data/a b.txt");
    assert.equal(stub.calls[1]!.path, "/api/sessions/session%2Fone/artifact-versions/version%2Fone/content");
    assert.equal(file, "file body");
    assert.equal(artifact, "artifact body");
  });
});

describe("writes that must not be loose", () => {
  it("deletes a session by repeating its id back as confirmation", async () => {
    const stub = new StubClient().reply({ deleted: "session/one" });

    await sessions.deleteSession(stub.asClient(), "session/one");

    assert.equal(stub.calls[0]!.path, "/api/sessions/session%2Fone");
    assert.equal(stub.calls[0]!.init.method, "DELETE");
    assert.deepEqual(json(stub.calls[0]!), { confirmationId: "session/one" });
  });

  it("sends the Runner allowlist whole, including an empty list", async () => {
    const stub = new StubClient().reply({}).reply({});
    const client = stub.asClient();

    await sessions.setProjectRunnerIds(client, "project/one", ["local", "gpu-01"]);
    await sessions.setProjectRunnerIds(client, "project/one", []);

    assert.equal(stub.calls[0]!.path, "/api/projects/project%2Fone");
    assert.equal(stub.calls[0]!.init.method, "PATCH");
    assert.deepEqual(json(stub.calls[0]!), { runnerIds: ["local", "gpu-01"] });
    // An empty array means "no machine may run this", not "leave it alone".
    assert.deepEqual(json(stub.calls[1]!), { runnerIds: [] });
  });
});

describe("uploading", () => {
  it("posts one multipart batch with every file and the conflict policy", async () => {
    const stub = new StubClient().reply({ files: [] });
    const first = new File(["a"], "a.txt", { type: "text/plain" });
    const second = new File(["b"], "b.csv", { type: "text/csv" });

    await sessions.uploadWorkspaceFiles(stub.asClient(), "session/one", [first, second], "overwrite");

    const call = stub.calls[0]!;
    const url = split(call);
    assert.equal(url.pathname, "/api/sessions/session%2Fone/workspace/upload");
    assert.equal(url.query.get("conflict"), "overwrite");
    assert.equal(call.init.method, "POST");
    assert.ok(call.init.body instanceof FormData, "the upload body is not multipart");
    const files = call.init.body.getAll("files");
    assert.equal(files.length, 2);
    assert.deepEqual(files.map((entry) => (entry as File).name), ["a.txt", "b.csv"]);
  });

  it("defaults to rename, which does not destroy a file the agent may have read", async () => {
    const stub = new StubClient().reply({ files: [] });

    await sessions.uploadWorkspaceFiles(stub.asClient(), "session/one", [new File(["a"], "a.txt")]);

    assert.equal(split(stub.calls[0]!).query.get("conflict"), "rename");
  });

  it("reads the per-file ceiling off health and keeps an absent block absent", async () => {
    const stub = new StubClient().reply({ workspace: { maxFileBytes: 1024 } }).reply({});
    const client = stub.asClient();

    assert.equal(await sessions.getWorkspaceUploadLimit(client), 1024);
    assert.equal(await sessions.getWorkspaceUploadLimit(client), undefined);
    assert.equal(stub.calls[0]!.path, "/api/health");
    assert.equal(stub.calls[1]!.path, "/api/health");
  });
});

describe("failures", () => {
  it("hands the original rejection back to the caller", async () => {
    const failure = new Error("409 conflict");
    const stub = new StubClient().fail(failure);

    await assert.rejects(
      () => sessions.listProjects(stub.asClient()),
      (reason: unknown) => reason === failure,
    );
  });
});
