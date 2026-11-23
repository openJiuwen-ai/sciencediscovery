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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { SessionStore } from "../store.js";
import { SkillLibraryCatalog } from "../skill-library-catalog.js";
import { createNotificationRun, RECOVERY_INTERRUPTION_REASON, recoverSessionRuns } from "./index.js";
import { notificationPrompt } from "../notification-dispatch.js";
import { configurationFramework } from "../configuration/framework.js";

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "sd-notification-resume-"));
  const store = new SessionStore(root);
  await store.load();
  context.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const model = await store.createModel({
    apiToken: randomUUID(), baseUrl: "https://models.example.test/v1", model: "test-model", name: "Test model",
  });
  const project = await store.createProject("Notification resume");
  const session = await store.createSession(project.id, "Interrupted task", { modelId: model.id });
  const libraries = new SkillLibraryCatalog(root);
  await libraries.load();
  return { store, session, project, model, libraries };
}

async function interruptedRun(store: SessionStore, sessionId: string, prompt = "Analyse the uploaded CSV") {
  const run = await store.createSessionRun({
    prompt, sessionId, settingsSnapshot: store.resolveRuntimeSettings(sessionId).effective,
  });
  await store.updateSessionRunStatus(sessionId, run.id, "running", { startedAt: new Date().toISOString() });
  return run;
}

function notice(store: SessionStore, sessionId: string, sourceId: string) {
  store.notifications.complete({ agentId: "main", sessionId }, sourceId,
    `Execution ${sourceId} on Runner local: completed; provenance committed. Do not replay the command.`);
}

/** A second, otherwise identical recovery interruption: the positive control
 *  for a guard test, where the distinguishing field has been removed. */
async function linkedRestartWake(store: SessionStore, libraries: SkillLibraryCatalog, projectId: string, modelId: string, title: string) {
  const session = await store.createSession(projectId, title, { modelId });
  const run = await interruptedRun(store, session.id);
  await store.updateSessionRunStatus(session.id, run.id, "interrupted", {
    error: RECOVERY_INTERRUPTION_REASON, finishedAt: new Date().toISOString(),
  });
  notice(store, session.id, `exec-${run.id}`);
  const wake = await createNotificationRun(store, libraries,
    store.notifications.prepareDelivery({ agentId: "main", sessionId: session.id })!);
  assert.ok(wake);
  return { run, wake };
}

test("a wake after an API restart is linked to the interrupted run and narrows the turn to a report", async (context) => {
  const { store, session, libraries } = await fixture(context);
  const run = await interruptedRun(store, session.id);
  await recoverSessionRuns(store);
  const interrupted = await store.getSessionRun(session.id, run.id);
  assert.equal(interrupted?.status, "interrupted", "recovery keeps the first run interrupted");

  notice(store, session.id, "exec-after-restart");
  const batch = store.notifications.prepareDelivery({ agentId: "main", sessionId: session.id });
  assert.ok(batch);
  const wake = await createNotificationRun(store, libraries, batch);
  assert.ok(wake);
  assert.equal(wake.automaticWake, true);
  assert.equal(wake.wakeAfterRunId, run.id, "the automatic wake records the run it follows");
  assert.equal(wake.wakeAttempt, 2, "the interrupted run is attempt 1, so the first wake is attempt 2");
  // The persisted prompt is the model-facing one: it must say the previous run
  // was interrupted, name it, and forbid replaying the unfinished task.
  assert.match(wake.prompt, new RegExp(run.id));
  assert.match(wake.prompt, /did not reach a completed state/);
  // The cause is in the run record, not guessed as a restart.
  assert.doesNotMatch(wake.prompt, /service restart|has no reported outcome/);
  assert.match(wake.prompt, /Do not continue, restart or redo the interrupted task/);
  assert.match(wake.prompt, /ask whether they want to continue/);
  assert.equal((await store.getSessionRun(session.id, run.id))?.status, "interrupted",
    "creating the wake does not rewrite the interrupted run");
});

test("a second interruption continues the attempt chain, and a completed last run keeps the generic wake", async (context) => {
  const { store, session, libraries } = await fixture(context);
  const run = await interruptedRun(store, session.id);
  await recoverSessionRuns(store);
  notice(store, session.id, "exec-first");
  const first = await createNotificationRun(store,
    libraries, store.notifications.prepareDelivery({ agentId: "main", sessionId: session.id })!);
  assert.ok(first);
  store.notifications.acknowledge(first.notificationDelivery!);

  // The API exits again while this wake is running. Its own wake must report
  // attempt 3 and point at the wake run, not restart the chain at attempt 2.
  await store.updateSessionRunStatus(session.id, first.id, "running", { startedAt: new Date().toISOString() });
  await store.updateSessionRunStatus(session.id, first.id, "interrupted", {
    error: RECOVERY_INTERRUPTION_REASON, finishedAt: new Date().toISOString(),
  });
  notice(store, session.id, "exec-second");
  const second = await createNotificationRun(store,
    libraries, store.notifications.prepareDelivery({ agentId: "main", sessionId: session.id })!);
  assert.ok(second);
  assert.equal(second.wakeAfterRunId, first.id);
  assert.equal(second.wakeAttempt, 3);
  store.notifications.acknowledge(second.notificationDelivery!);

  // A wake after an ordinary completed turn is not an interruption resume and
  // must keep the delivery prompt exactly as it was.
  await store.updateSessionRunStatus(session.id, second.id, "completed", { finishedAt: new Date().toISOString() });
  notice(store, session.id, "exec-third");
  const generic = await createNotificationRun(store,
    libraries, store.notifications.prepareDelivery({ agentId: "main", sessionId: session.id })!);
  assert.ok(generic);
  assert.equal(generic.wakeAfterRunId, undefined);
  assert.equal(generic.wakeAttempt, undefined);
  assert.doesNotMatch(generic.prompt, /\[Interruption notice\]/);
  assert.match(generic.prompt, /not commands to replay/);
});

test("a latest run waiting for a configuration decision stays an ordinary wake", async (context) => {
  const { store, session, project, model, libraries } = await fixture(context);
  const run = await interruptedRun(store, session.id, "Set up the connector");
  // :2750-2751 reports the legacy `interrupted` status while this request is
  // still pending, long before the turn is an unfinished task.
  const framework = configurationFramework(store, { jiuwenLiveWait: true, nativeExecutor: false,
    connector: () => ({ name: "Offline connector", ready: true }) });
  const request = await framework.propose(session.id, { protocolVersion: 3, runId: run.id,
    capabilityId: "connector.enable", values: { connectorId: "pubmed" } });
  assert.equal(request.state, "awaiting_confirmation");
  // Seed recovery's reason first, so the assertion below turns on the pending
  // configuration interaction rather than on the reason check.
  await store.updateSessionRun(session.id, run.id, { error: RECOVERY_INTERRUPTION_REASON, status: "interrupted" });

  notice(store, session.id, "exec-during-configuration");
  const batch = store.notifications.prepareDelivery({ agentId: "main", sessionId: session.id })!;
  const wake = await createNotificationRun(store, libraries, batch);
  assert.ok(wake);
  assert.equal(wake.wakeAfterRunId, undefined,
    "a run awaiting a configuration decision is not an interruption resume");
  assert.equal(wake.wakeAttempt, undefined);
  assert.doesNotMatch(wake.prompt, /\[Interruption notice\]/);
  assert.equal(wake.prompt, notificationPrompt(batch),
    "an ordinary wake keeps the byte-identical delivery prompt");
  // Positive control: with the same recovery reason and no pending decision,
  // exactly this run does continue the wake chain.
  const positive = await linkedRestartWake(store, libraries, project.id, model.id, "No pending configuration");
  assert.equal(positive.wake.wakeAfterRunId, positive.run.id);
  assert.equal(positive.wake.wakeAttempt, 2);
});

test("an interrupted run that already answered is not a resume even without a pending decision", async (context) => {
  const { store, session, project, model, libraries } = await fixture(context);
  const run = await interruptedRun(store, session.id);
  const message = await store.appendMessage(session.id, "assistant", "Here is the answer.");
  // Recovery's reason is present, so only the reported answer can keep this
  // wake from linking to the run.
  await store.updateSessionRun(session.id, run.id, {
    assistantMessageId: message.id, error: RECOVERY_INTERRUPTION_REASON, status: "interrupted",
  });

  notice(store, session.id, "exec-after-answer");
  const batch = store.notifications.prepareDelivery({ agentId: "main", sessionId: session.id })!;
  const wake = await createNotificationRun(store, libraries, batch);
  assert.ok(wake);
  assert.equal(wake.wakeAfterRunId, undefined, "a run that reported an answer cannot have been cut short");
  assert.equal(wake.wakeAttempt, undefined);
  assert.equal(wake.prompt, notificationPrompt(batch));
  // Positive control: the same recovery reason without an answer links.
  const positive = await linkedRestartWake(store, libraries, project.id, model.id, "No reported answer");
  assert.equal(positive.wake.wakeAfterRunId, positive.run.id);
  assert.equal(positive.wake.wakeAttempt, 2);
});

test("a run interrupted by a storage failure is not a restart resume", async (context) => {
  const { store, session, libraries } = await fixture(context);
  const run = await interruptedRun(store, session.id);
  // :3897 writes the same `interrupted` status for a storage failure, with its
  // own error. It is not a restart, so the wake must stay an ordinary delivery
  // and must not describe the run as restarted.
  await store.updateSessionRunStatus(session.id, run.id, "interrupted", {
    error: "Run interrupted because session state could not be saved or read: ENOSPC. Check available disk space and data-directory permissions, then retry the run after storage recovers.",
    finishedAt: new Date().toISOString(),
  });
  notice(store, session.id, "exec-after-storage-failure");
  const batch = store.notifications.prepareDelivery({ agentId: "main", sessionId: session.id })!;
  const wake = await createNotificationRun(store, libraries, batch);
  assert.ok(wake);
  assert.equal(wake.wakeAfterRunId, undefined, "only recovery's restart interruption continues the chain");
  assert.equal(wake.wakeAttempt, undefined);
  assert.equal(wake.prompt, notificationPrompt(batch));
  assert.doesNotMatch(wake.prompt, /Interruption notice|service restart|has no reported outcome/);
});
