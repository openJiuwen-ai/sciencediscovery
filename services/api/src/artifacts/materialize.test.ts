// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CasStore } from "@sciencediscovery/cas";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { listWorkspaceFiles } from "./index.js";
import { materializeArtifact } from "./materialize.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

test("a promoted version keeps its attribution across the listing that follows", async t => {
  // The defect (#1125): the revision was stamped with `new Date()` taken after
  // the copy, while the file kept its own mtime — and with `reuseIdentical` the
  // copy never touches the file at all. The next listing therefore saw a change,
  // appended a revision with `origin: "unknown"` and no `parentRevisionId`, and
  // moved `currentRevisionId` onto it: the attribution, the lineage and the
  // Artifact link all disappeared from a file whose bytes never changed.
  const root = await mkdtemp(join(tmpdir(), "artifact-listing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root); store.setAvailableSkillIds([]); await store.load();
  const project = await store.createProject("listing");
  const session = await store.createSession(project.id, "lead", {}, {}, { allowUnconfiguredModel: true });
  const cas = new CasStore(root);
  const bytes = Buffer.from("delivered report\n".repeat(500));
  const version = await store.createArtifactVersion({ sessionId: session.id, content: await cas.put(bytes),
    kind: "other", logicalName: "delivered.md", mediaType: "text/markdown", origin: "llm_declared" });
  const input = { sessionId: session.id, workspaceRoot: store.workspacePath(session.id),
    artifactId: version.artifact.id, version: 1, path: "delivered.md" };
  await materializeArtifact(store, input);
  const delivered = store.getWorkspaceFileProvenance(session.id, "delivered.md")!;
  assert.equal(delivered.currentRevision.origin, "system");
  assert.equal(delivered.currentRevision.contentHash, version.version.content.hash);
  assert.deepEqual(delivered.currentRevision.artifactVersionIds, [version.version.id]);
  assert.equal(delivered.artifacts.length, 1, "the delivery is linked to the Artifact version");

  // Two listings, because the first refresh is what used to append the empty
  // revision; a second one proves the fix is stable rather than deferred.
  for (let pass = 0; pass < 2; pass += 1) {
    await listWorkspaceFiles(store, session.id);
    const after = store.getWorkspaceFileProvenance(session.id, "delivered.md")!;
    assert.equal(after.currentRevision.id, delivered.currentRevision.id,
      `listing pass ${pass + 1} must not replace the delivered revision`);
    assert.equal(after.currentRevision.origin, "system");
    assert.equal(after.currentRevision.contentHash, version.version.content.hash);
    assert.deepEqual(after.currentRevision.artifactVersionIds, [version.version.id]);
    assert.equal(after.revisions.length, delivered.revisions.length, "no revision is appended for an unchanged file");
    assert.equal(after.lineage.length, delivered.lineage.length, "the lineage survives the listing");
    assert.deepEqual(after.artifacts, delivered.artifacts, "the Artifact link survives the listing");
  }

  // Re-materializing the identical bytes returns early without touching the
  // file, which is the branch that made the mismatch unconditional.
  await materializeArtifact(store, input);
  await listWorkspaceFiles(store, session.id);
  const retried = store.getWorkspaceFileProvenance(session.id, "delivered.md")!;
  assert.equal(retried.currentRevision.origin, "system", "a re-materialized identical copy stays attributed");
  assert.deepEqual(retried.currentRevision.artifactVersionIds, [version.version.id]);
});

test("a same-size edit on disk still degrades to unknown", async t => {
  // The reason the fix is at the write sites and not in the reconcile branch:
  // reconciliation sees only path/mtime/size, so it cannot tell a clock that ran
  // late from a real edit. This is the behaviour that must not be traded away.
  const root = await mkdtemp(join(tmpdir(), "artifact-listing-edit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root); store.setAvailableSkillIds([]); await store.load();
  const project = await store.createProject("listing-edit");
  const session = await store.createSession(project.id, "lead", {}, {}, { allowUnconfiguredModel: true });
  const cas = new CasStore(root);
  const bytes = Buffer.from("delivered report\n".repeat(500));
  const version = await store.createArtifactVersion({ sessionId: session.id, content: await cas.put(bytes),
    kind: "other", logicalName: "edited.md", mediaType: "text/markdown", origin: "llm_declared" });
  await materializeArtifact(store, { sessionId: session.id, workspaceRoot: store.workspacePath(session.id),
    artifactId: version.artifact.id, version: 1, path: "edited.md" });
  const edited = Buffer.from(bytes); edited[0] = (edited[0]! + 1) % 256;
  await writeFile(join(store.workspacePath(session.id), "edited.md"), edited);
  await listWorkspaceFiles(store, session.id);
  const after = store.getWorkspaceFileProvenance(session.id, "edited.md")!;
  assert.equal(after.currentRevision.origin, "unknown", "an unrecorded external edit is not credited to the Artifact");
  assert.deepEqual(after.currentRevision.artifactVersionIds, []);
});

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
  // Contract change (#708): a corrupt pool copy no longer fails the request —
  // the intact mirror in the next layout is served instead, whole.
  const corruptHash = first.version.content.hash;
  const poolCopies = [
    `versioning/agent-state/blobs/sha256/${corruptHash}`,
    `versioning/data/blobs/sha256/${corruptHash}`,
  ];
  const legacyCopy = `cas/sha256/${corruptHash.slice(0, 2)}/${corruptHash}`;
  await writeFile(join(root, poolCopies[0]!), "corrupt");
  const served = await materializeArtifact(store, { ...input, path: "corrupt.dat" });
  assert.equal(served.sha256, corruptHash, "the intact copy is what gets published");
  assert.deepEqual(await readFile(join(childRoot, "corrupt.dat")), original, "the whole object, never the corrupt bytes");
  // With every copy corrupt there is nothing to serve, and the destination must
  // not be left behind. Which layer names the corruption is not the contract.
  await writeFile(join(root, poolCopies[1]!), "corrupt");
  await mkdir(dirname(join(root, legacyCopy)), { recursive: true });
  await writeFile(join(root, legacyCopy), "corrupt");
  const integrityShaped = (error: unknown) => {
    const seen = [String((error as Error)?.message ?? ""), String((error as Error & { cause?: Error })?.cause?.message ?? "")];
    return seen.some((text) => /integrity|checksum|size/i.test(text));
  };
  await assert.rejects(materializeArtifact(store, { ...input, path: "corrupt-again.dat" }), integrityShaped);
  await assert.rejects(readFile(join(childRoot, "corrupt-again.dat")), /ENOENT/);
});
