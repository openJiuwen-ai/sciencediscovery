// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RefStore, VersionStore, withWorkspaceAdmission, withWorkspaceRetirement, workspaceHeadName } from "@sciencediscovery/cas";
import { SessionStore } from "./store.js";

async function fixture(t: TestContext) {
  const data = await mkdtemp(join(tmpdir(), "store-delete-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const store = new SessionStore(data); await store.load();
  const project = await store.createProject("Deletion");
  const session = await store.createSession(project.id, "Session", {}, {}, { allowUnconfiguredModel: true });
  return { data, store, project, session, root: store.workspacePath(session.id), versions: new VersionStore(data) };
}

test("Session deletion waits for main/child commits and fences late creation; final CAS is retained", async (t) => {
  const { data, store, session, root, versions } = await fixture(t);
  await store.createAgentWorkspace(session.id, "child");
  const child = store.agentWorkspacePath(session.id, "child");
  const ready = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
  t.after(() => finish.resolve());
  const writer = store.mutateWorkspace(child, "test", async () => {
    ready.resolve(); await finish.promise; await writeFile(join(child, "result"), "final-child");
  });
  await ready.promise;
  let deleted = false;
  const deletion = store.deleteSession(session.id, session.id).then(() => { deleted = true; });
  let closed = false;
  for (let i = 0; i < 100 && !closed; i++) {
    try { await withWorkspaceAdmission(versions, join(dirname(root), "probe"), async () => {}); }
    catch (error) { assert.match(String(error), /deleted/); closed = true; }
    if (!closed) await delay(5);
  }
  assert.ok(closed); assert.equal(deleted, false);
  await assert.rejects(store.createAgentWorkspace(session.id, "late"), /deleted/);
  finish.resolve(); await writer; await deletion;
  assert.equal(store.getSession(session.id), undefined);
  await assert.rejects(stat(root), { code: "ENOENT" });
  const refs = await RefStore.open(versions);
  try { assert.ok(refs.head(workspaceHeadName(child))); assert.ok(refs.head(workspaceHeadName(root))); }
  finally { refs.close(); }
  const reopened = new SessionStore(data); await reopened.load();
  assert.equal(reopened.getSession(session.id), undefined);
});

test("catalog failure rolls back Session root and reopens admission only after restoring files", async (t) => {
  const { store, session, root } = await fixture(t);
  await writeFile(join(root, "input"), "keep");
  const internal = store as unknown as { saveCatalog(): Promise<void> };
  const save = internal.saveCatalog.bind(store);
  internal.saveCatalog = async () => { throw new Error("injected catalog failure"); };
  await assert.rejects(store.deleteSession(session.id, session.id), /injected catalog failure/);
  internal.saveCatalog = save;
  assert.ok(store.getSession(session.id));
  assert.equal(await readFile(join(root, "input"), "utf8"), "keep");
  await store.mutateWorkspace(root, "after-rollback", async () => writeFile(join(root, "next"), "ok"));
});

test("startup restores a staged Session under its persistent deletion gate", async (t) => {
  const { data, store, session, root, versions } = await fixture(t);
  await store.mutateWorkspace(root, "initial", async () => writeFile(join(root, "input"), "keep"));
  const scope = dirname(root); const journal = join(data, ".trash", "interrupted-session");
  const staged = join(journal, "data", relative(data, scope));
  await mkdir(dirname(staged), { recursive: true });
  await writeFile(join(journal, "operation.json"), JSON.stringify({ root: journal, sessionIds: [session.id],
    scopes: [scope], entries: [{ source: scope, staged }] }));
  await assert.rejects(withWorkspaceRetirement(versions, [scope], journal, async () => {
    await rename(scope, staged); throw new Error("simulated interruption");
  }), /simulated interruption/);
  await assert.rejects(store.mutateWorkspace(root, "stale", async () => {}), /deleted/);
  const reopened = new SessionStore(data); await reopened.load();
  assert.equal(await readFile(join(root, "input"), "utf8"), "keep");
  await reopened.mutateWorkspace(root, "recovered", async () => writeFile(join(root, "next"), "ok"));
  await assert.rejects(stat(journal), { code: "ENOENT" });
});

test("Project deletion waits for admitted Session creation and blocks subsequent creation", async (t) => {
  const { store, project } = await fixture(t);
  const internal = store as unknown as { saveCatalog(): Promise<void> };
  const save = internal.saveCatalog.bind(store);
  const ready = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
  t.after(() => finish.resolve());
  internal.saveCatalog = async () => { ready.resolve(); await finish.promise; await save(); };
  const creation = store.createSession(project.id, "Concurrent", {}, {}, { allowUnconfiguredModel: true });
  await ready.promise;
  let deleted = false;
  const deletion = store.deleteProject(project.id, project.id).then(() => { deleted = true; });
  await delay(50); assert.equal(deleted, false);
  await assert.rejects(store.createSession(project.id, "Too late", {}, {}, { allowUnconfiguredModel: true }), /deleted/);
  internal.saveCatalog = save; finish.resolve();
  const created = await creation; await deletion;
  assert.equal(store.getProject(project.id), undefined); assert.equal(store.getSession(created.id), undefined);
});
