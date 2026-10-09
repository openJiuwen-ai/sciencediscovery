// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasStore } from "@sciencediscovery/cas";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { materializeArtifact } from "./materialize.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

for (const binary of [false, true]) test(`immutable artifact edit roundtrip, binary=${binary}`, async t => {
  const root = await mkdtemp(join(tmpdir(), "artifact-edit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root); store.setAvailableSkillIds([]); await store.load();
  const project = await store.createProject("edit");
  const session = await store.createSession(project.id, "lead", {}, {}, { allowUnconfiguredModel: true });
  const childRoot = store.agentWorkspacePath(session.id, "editor"); await mkdir(childRoot, { recursive: true });
  const cas = new CasStore(root);
  const original = binary ? Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 256))
    : Buffer.from("引用 [1] — αβ\r\n".repeat(10_000));
  const first = await store.createArtifactVersion({ sessionId: session.id, content: await cas.put(original),
    kind: "other", logicalName: "source.dat", mediaType: "application/octet-stream", origin: "llm_declared",
    references: [{ id: "source-evidence", kind: "evidence", label: "evidence1" }] });
  const input = { sessionId: session.id, workspaceRoot: childRoot, subagentId: "editor", sourcePathPrefix: "subagents/editor",
    artifactId: first.artifact.id, version: 1, path: "editable.dat" };
  const receipt = await materializeArtifact(store, input);
  assert.equal(receipt.sha256, first.version.content.hash);
  assert.equal(JSON.stringify(receipt).length < 600, true, "tool returns metadata, not content");
  assert.deepEqual(await readFile(join(childRoot, "editable.dat")), original);
  await materializeArtifact(store, input); // Identical input is safe to retry.
  const edited = Buffer.from(original); edited[100] = edited[100]! ^ 1;
  await writeFile(join(childRoot, "editable.dat"), edited);
  await assert.rejects(materializeArtifact(store, input), /already exists/);
  const publish = { sessionId: session.id, content: await cas.putFile(join(childRoot, "editable.dat")),
    kind: "other" as const, logicalName: "editable.dat", mediaType: "application/octet-stream",
    artifactId: first.artifact.id, baseVersionId: first.version.id, publicationId: "editor:publish-1" };
  const second = await store.createArtifactVersion(publish);
  assert.equal(second.artifact.id, first.artifact.id);
  assert.equal(second.artifact.name, "source.dat");
  assert.equal(second.version.version, 2);
  assert.deepEqual(second.version.references, first.version.references, "revision retains existing citation chip mappings");
  assert.ok(second.version.inputArtifactVersionIds.includes(first.version.id));
  assert.deepEqual(await cas.read(first.version.content.hash), original);
  assert.deepEqual(await cas.read(second.version.content.hash), edited);
  const reopened = new SessionStore(root); reopened.setAvailableSkillIds([]); await reopened.load();
  assert.equal((await reopened.createArtifactVersion(publish)).version.id, second.version.id, "durable retry identity");
  await assert.rejects(reopened.createArtifactVersion({ ...publish, content: first.version.content }), /PUBLICATION_CONFLICT/);
  await assert.rejects(reopened.createArtifactVersion({ ...publish, publicationId: "different-call" }), /VERSION_CONFLICT/);
  const concurrent = await Promise.allSettled(["writer-a", "writer-b"].map(publicationId =>
    reopened.createArtifactVersion({ ...publish, baseVersionId: second.version.id, publicationId })));
  assert.equal(concurrent.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter(r => r.status === "rejected").length, 1);
  assert.deepEqual(await readFile(join(childRoot, "editable.dat")), edited, "conflicts preserve edits");
  await assert.rejects(materializeArtifact(store, { ...input, path: "../escape" }));
  const outside = join(root, "outside"); await mkdir(outside); await symlink(outside, join(childRoot, "link"));
  await assert.rejects(materializeArtifact(store, { ...input, path: "link/escape" }), /symbolic link/);
  const other = await store.createProject("other");
  const otherSession = await store.createSession(other.id, "other", {}, {}, { allowUnconfiguredModel: true });
  await assert.rejects(materializeArtifact(store, { ...input, sessionId: otherSession.id }), /not found/);
  await assert.rejects(store.createArtifactVersion({ ...publish, sessionId: otherSession.id }), /not found/);
  // A corrupt backing blob must never publish a partial destination.
  await writeFile(join(root, "versioning/agent-state/blobs/sha256", first.version.content.hash), "corrupt");
  await assert.rejects(materializeArtifact(store, { ...input, path: "corrupt.dat" }), /integrity|checksum|size/);
  await assert.rejects(readFile(join(childRoot, "corrupt.dat")), /ENOENT/);
});
