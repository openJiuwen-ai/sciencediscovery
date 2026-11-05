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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { TestContext } from "node:test";

import type { ScientificArtifactKind } from "@sciencediscovery/schema";
import { ProvenanceRecorder } from "@sciencediscovery/provenance";

import { offlineMcpTransport } from "./mcp/offline-transport.fixture.js";
import { createApiServer, type ServerConfig } from "./server.js";
import { SessionStore } from "./store.js";

interface Fixture {
  dataDir: string;
  recorder: ProvenanceRecorder;
  session: { id: string; projectId: string };
  store: SessionStore;
}

interface VersionSeed {
  content: string;
  kind: ScientificArtifactKind;
  logicalName: string;
  mediaType: string;
}

async function createFixture(context: TestContext): Promise<Fixture> {
  const dataDir = await mkdtemp(resolve(tmpdir(), "sciencediscovery-artifact-diff-media-"));
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({
    apiToken: "test",
    baseUrl: "https://models.example.test/v1",
    model: "test",
    name: "Test",
  });
  const project = await store.createProject("Artifact diff media project");
  const session = await store.createSession(project.id, "Artifact diff media session", { modelId: model.id });
  const recorder = new ProvenanceRecorder(dataDir, store);
  return { dataDir, recorder, session, store };
}

/** Add one version to an artifact, chaining on the previous one when `base` is given. */
async function seedVersion(
  fixture: Fixture,
  seed: VersionSeed,
  base?: { artifactId: string; versionId: string },
): Promise<{ artifactId: string; versionId: string }> {
  const content = await fixture.recorder.cas.put(seed.content);
  const { artifact, version } = await fixture.store.createArtifactVersion({
    content,
    kind: seed.kind,
    logicalName: seed.logicalName,
    mediaType: seed.mediaType,
    sessionId: fixture.session.id,
    ...(base ? { artifactId: base.artifactId, baseVersionId: base.versionId } : {}),
  });
  return { artifactId: artifact.id, versionId: version.id };
}

/**
 * Start the API server over an already-seeded fixture. Kept separate from `createFixture` so the
 * caller can write the artifact versions first: `createApiServer`'s `ready` chain loads the
 * catalog once, and a version written after that load is never seen by the route.
 */
async function startHttpServer(context: TestContext, fixture: Fixture): Promise<{ origin: string }> {
  const config: ServerConfig = {
    authToken: "test-token",
    dataDir: fixture.dataDir,
    gatewayIdleTimeoutMs: 240_000,
    gatewayTurnTimeoutMs: 0,
    host: "127.0.0.1",
    kernelIdleTimeoutMs: 0,
    modelCatalogPath: resolve(fixture.dataDir, "model-catalog/absent.json"),
    paperPythonPath: resolve(fixture.dataDir, "paper-python"),
    paperWorkerPath: resolve(fixture.dataDir, "paper-worker.py"),
    permissionWaitTimeoutMs: 0,
    port: 0,
    runnerExecTimeoutMs: 0,
    runnerMaxOutputBytes: 1_000_000,
    runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "runner-token",
    runnerUrl: "http://127.0.0.1:1",
    sshConfigPath: resolve(fixture.dataDir, "ssh-config"),
    staticDir: resolve(fixture.dataDir, "web"),
    workspaceUpload: {
      maxFileBytes: 1_000_000,
      maxRequestBytes: 10_000_000,
      maxWorkspaceBytes: 10_737_418_240,
    },
    memoryGraph: { url: "http://127.0.0.1:17674", internalToken: "test" },
    evolve: { url: "http://127.0.0.1:4313", internalToken: "test" },
  };
  const server = createApiServer(config, { mcpTransport: offlineMcpTransport });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function diff(origin: string, sessionId: string, versionId: string): Promise<{ body: { error?: string }; status: number }> {
  const response = await fetch(`${origin}/api/sessions/${sessionId}/artifact-versions/${versionId}/diff`, {
    headers: { authorization: "Bearer test-token" },
  });
  return { body: await response.json().catch(() => ({})) as { error?: string }, status: response.status };
}

test("a non-textual artifact pair answers a client error instead of 500", async (context) => {
  // The route is reachable with any seeded versions: build the pair in the store's catalog
  // rather than driving an execution, because the media-type rule is checked before any CAS
  // read. Two `.zip` versions are the case the issue measured.
  const fixture = await createFixture(context);
  const binaryFirst = await seedVersion(fixture, {
    content: "PK\u0003\u0004 first bundle",
    kind: "other",
    logicalName: "bundle.zip",
    mediaType: "application/zip",
  });
  const binary = await seedVersion(fixture, {
    content: "PK\u0003\u0004 second bundle",
    kind: "other",
    logicalName: "bundle.zip",
    mediaType: "application/zip",
  }, binaryFirst);

  // Either side being non-textual makes the comparison unavailable, so a pair that switches
  // from text to binary is refused the same way (the media type is per version, not per
  // artifact).
  const mixedFirst = await seedVersion(fixture, {
    content: "# notes\n",
    kind: "markdown",
    logicalName: "notes.md",
    mediaType: "text/markdown",
  });
  const mixed = await seedVersion(fixture, {
    content: "PK\u0003\u0004 zipped notes",
    kind: "markdown",
    logicalName: "notes.md",
    mediaType: "application/zip",
  }, mixedFirst);

  const textFirst = await seedVersion(fixture, {
    content: "# notes\nfirst\n",
    kind: "markdown",
    logicalName: "diffable.md",
    mediaType: "text/markdown",
  });
  const text = await seedVersion(fixture, {
    content: "# notes\nsecond\n",
    kind: "markdown",
    logicalName: "diffable.md",
    mediaType: "text/markdown",
  }, textFirst);

  // Seed first, start second: the `ready` chain loads the catalog exactly once, so a version
  // written after that load is invisible to the route and the request answers 500 whenever the
  // load wins. Writing the versions before the server exists removes the race instead of waiting
  // for the other side of it.
  const { origin } = await startHttpServer(context, fixture);

  // The comparison is a client-input problem: the pair exists, it just cannot be diffed. A
  // 500 reads as "the server is broken", hides the reason, and logs a false
  // unclassified_request_error for a request the client can avoid.
  for (const [label, versions] of [["binary", binary], ["mixed", mixed]] as const) {
    const refused = await diff(origin, fixture.session.id, versions.versionId);
    assert.deepEqual(
      refused,
      { body: { error: "Diff is available only for textual or comparable artifact versions" }, status: 400 },
      `${label} pair must answer 400 with the reason, not 500`,
    );
  }

  // The control: a textual pair keeps diffing, so the classification does not swallow the
  // feature it protects.
  const compared = await diff(origin, fixture.session.id, text.versionId);
  assert.equal(compared.status, 200);
  const lines = (compared.body as unknown as { lines: Array<{ kind: string; text: string }> }).lines;
  assert.ok(lines.some((line) => line.kind === "removed" && line.text === "first"), "the old line is removed");
  assert.ok(lines.some((line) => line.kind === "added" && line.text === "second"), "the new line is added");
});
