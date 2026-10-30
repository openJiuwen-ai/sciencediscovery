// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from '../../../test/support/tagged/compat.mjs';
const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64', 'arch:arm64'] });
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './store.js';
import { normalizeRuntimeSettings } from './store/settings.js';

test('approval defaults resolve only at creation, persist, and never follow sibling activity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'approval-defaults-'));
  const store = new SessionStore(root);
  // Physical reclamation outlives the delete request, so it has to settle
  // before the root is removed or the two race over the same directories.
  t.after(async () => { await store.whenDeletionsSettle(); store.close(); await rm(root, {recursive:true, force:true}); });
  await store.load();
  const project = await store.createProject('Explicit defaults');
  const other = await store.createProject('Independent project');
  const create = (projectId = project.id, approvalMode?: 'always_allow' | 'ask_for_dangerous') =>
    store.createSession(projectId, 'New session', {}, {approvalMode}, {allowUnconfiguredModel:true});
  const old = await create();
  assert.equal(old.approvalMode, 'ask_for_dangerous');
  await store.replaceGlobalSettings({defaultApprovalMode:'always_allow'});
  assert.equal((await create()).approvalMode, 'always_allow');
  assert.equal(store.getProjectSettings(project.id).sources.defaultApprovalMode, 'global');
  await store.replaceProjectSettings(project.id, {defaultApprovalMode:'ask_for_dangerous'});
  assert.equal((await create()).approvalMode, 'ask_for_dangerous');
  assert.equal((await create(other.id)).approvalMode, 'always_allow');
  assert.equal((await create(project.id, 'always_allow')).approvalMode, 'always_allow');
  assert.equal(store.getProjectSettings(project.id).sources.defaultApprovalMode, 'project');
  await store.replaceProjectSettings(project.id, {defaultApprovalMode:'always_allow'});
  assert.equal((await create(project.id, 'ask_for_dangerous')).approvalMode, 'ask_for_dangerous');
  const inherited = await create();
  await store.setApprovalMode(inherited.id, 'ask_for_dangerous');
  await store.setApprovalMode(old.id, 'always_allow');
  await store.appendMessage(old.id, 'user', 'Unrelated sibling activity');
  assert.equal((await create()).approvalMode, 'always_allow');
  assert.equal(store.getGlobalSettings().overrides.defaultApprovalMode, 'always_allow');
  assert.equal(store.getProjectSettings(project.id).overrides.defaultApprovalMode, 'always_allow');
  await store.replaceGlobalSettings({defaultApprovalMode:'ask_for_dangerous'});
  assert.equal(inherited.approvalMode, 'ask_for_dangerous');
  assert.equal(old.approvalMode, 'always_allow');
  store.close(); await store.load();
  assert.equal(store.getSession(old.id)?.approvalMode, 'always_allow');
  assert.equal((await create()).approvalMode, 'always_allow');
  await store.replaceProjectSettings(project.id, {});
  assert.equal((await create()).approvalMode, 'ask_for_dangerous');
  await store.replaceGlobalSettings({});
  assert.equal((await create()).approvalMode, 'ask_for_dangerous');
  await assert.rejects(store.replaceGlobalSettings({defaultApprovalMode:'invalid'}), /defaultApprovalMode/);
  await assert.rejects(store.replaceProjectSettings(project.id, {defaultApprovalMode:null}), /defaultApprovalMode/);
  await assert.rejects(store.replaceSessionSettings(old.id, {defaultApprovalMode:'always_allow'}), /only supported/);
  // Simulate untyped input at the runtime boundary; the public request type must forbid this field.
  const invalidPatch: unknown = {defaultApprovalMode:'always_allow'};
  await assert.rejects(store.updateSession(old.id, invalidPatch as Parameters<SessionStore['updateSession']>[1]), /only supported/);
  assert.equal(store.getSessionSettings(old.id).overrides.defaultApprovalMode, undefined);
  await assert.rejects(store.createSession(project.id, 'Invalid scope', {defaultApprovalMode:'always_allow'}), /only supported/);
  assert.deepEqual(normalizeRuntimeSettings({defaultApprovalMode:'invalid'}, new Set(), new Set(), false), {});
});

test('plugin experiment sessions retain explicit Ask under permissive saved defaults', async t => {
  const root = await mkdtemp(join(tmpdir(), 'approval-experiment-'));
  const store = new SessionStore(root);
  // Physical reclamation outlives the delete request, so it has to settle
  // before the root is removed or the two race over the same directories.
  t.after(async () => { await store.whenDeletionsSettle(); store.close(); await rm(root, {recursive:true, force:true}); });
  await store.load();
  await store.replaceGlobalSettings({defaultApprovalMode:'always_allow'});
  const project = await store.createProject('Experiment');
  const scope = {projectId:project.id};
  store.setAvailableSkillIds([]);
  const control = store.plugins;
  // Exercise the same compare-and-save bridge used by Project settings UI.
  await control.bridge(scope).invoke({apiVersion:1, pluginId:'host.settings', scope, kind:'command', method:'replace',
    input:{expectedRevision:control.snapshot(scope).revision, overrides:{defaultApprovalMode:'always_allow'}}}, new AbortController().signal);
  const candidate = await control.create(project.id, control.snapshot(scope).revision, {plugins:{plan:{enabled:false}}});
  const prepared = await control.command(project.id, candidate.id, 'prepare', {});
  for (const id of [prepared.experiments!.baselineSessionId, prepared.experiments!.candidateSessionId]) {
    assert.equal(store.getSession(id)?.approvalMode, 'ask_for_dangerous');
  }
});


test('failed plugin candidate creation cleans up its explicit-Ask baseline under permissive defaults', async t => {
  const root = await mkdtemp(join(tmpdir(), 'approval-experiment-failure-'));
  const store = new SessionStore(root);
  // Physical reclamation outlives the delete request, so it has to settle
  // before the root is removed or the two race over the same directories.
  t.after(async () => { await store.whenDeletionsSettle(); store.close(); await rm(root, {recursive:true, force:true}); });
  await store.load();
  store.setAvailableSkillIds([]);
  await store.replaceGlobalSettings({defaultApprovalMode:'always_allow'});
  const project = await store.createProject('Failed experiment');
  const create = store.createSession.bind(store);
  t.mock.method(store, 'createSession', async (...args: Parameters<SessionStore['createSession']>) => {
    assert.equal(args[3]?.approvalMode, 'ask_for_dangerous');
    assert.equal((args[2] as {defaultApprovalMode?: string}).defaultApprovalMode, undefined);
    if (args[1] === 'Plugin experiment: candidate') throw new Error('Injected candidate admission failure');
    const session = await create(...args);
    assert.equal(session.approvalMode, 'ask_for_dangerous');
    return session;
  });
  const control = store.plugins;
  const candidate = await control.create(project.id, control.snapshot({projectId:project.id}).revision, {plugins:{plan:{enabled:false}}});
  await assert.rejects(control.command(project.id, candidate.id, 'prepare', {}), /Injected candidate admission failure/);
  assert.deepEqual(store.listSessions(project.id), []);
  assert.equal(control.list(project.id)[0]?.status, 'candidate');
});
