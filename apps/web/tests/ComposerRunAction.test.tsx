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
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionRun } from "@sciencediscovery/schema";

import { ComposerNoModelNotice, ComposerRunButton, QueuedRunsPanel, queuedCancelToast, resolveComposerRunAction } from "../src/App.js";

const baseInput = {
  activeSessionId: "session-b",
  hasModel: true,
  message: "Summarize the dataset",
  modelsAvailable: true,
  reviewerCheckpointRunning: false,
  runningSessionIds: new Set<string>(),
  sessionArchived: false,
  stoppingSessionIds: new Set<string>(),
};

test("a run in another Session leaves the current Session runnable", () => {
  assert.deepEqual(
    resolveComposerRunAction({ ...baseInput, runningSessionIds: new Set(["session-a"]) }),
    { noModelReason: null, runDisabled: false, runLabel: "Run analysis", stopDisabled: false, stopVisible: false },
  );
});

test("the current Session offers Stop and keeps submit available for queueing", () => {
  assert.deepEqual(
    resolveComposerRunAction({ ...baseInput, runningSessionIds: new Set(["session-a", "session-b"]) }),
    { noModelReason: null, runDisabled: false, runLabel: "Add to queue", stopDisabled: false, stopVisible: true },
  );
});

test("a running manual Reviewer exposes Stop without pretending an Agent run is queued", () => {
  assert.deepEqual(
    resolveComposerRunAction({ ...baseInput, reviewerCheckpointRunning: true }),
    { noModelReason: null, runDisabled: false, runLabel: "Run analysis", stopDisabled: false, stopVisible: true },
  );
});

test("Stop is offered even when queue submit is unavailable", () => {
  assert.deepEqual(
    resolveComposerRunAction({
      ...baseInput,
      hasModel: false,
      message: "   ",
      runningSessionIds: new Set(["session-b"]),
    }),
    { noModelReason: "no-session-model", runDisabled: true, runLabel: "Add to queue", stopDisabled: false, stopVisible: true },
  );
});

test("a Stop already in flight disables only the Stop action", () => {
  assert.deepEqual(
    resolveComposerRunAction({
      ...baseInput,
      runningSessionIds: new Set(["session-b"]),
      stoppingSessionIds: new Set(["session-b"]),
    }),
    { noModelReason: null, runDisabled: false, runLabel: "Add to queue", stopDisabled: true, stopVisible: true },
  );
});

test("Run stays disabled without input, without a model, or on an archived Session", () => {
  assert.equal(resolveComposerRunAction({ ...baseInput, message: "  " }).runDisabled, true);
  assert.equal(resolveComposerRunAction({ ...baseInput, hasModel: false }).runDisabled, true);
  assert.equal(resolveComposerRunAction({ ...baseInput, sessionArchived: true }).runDisabled, true);
  assert.equal(resolveComposerRunAction({ ...baseInput, activeSessionId: undefined }).runDisabled, true);
  assert.equal(resolveComposerRunAction(baseInput).runDisabled, false);
});

test("distinguishes missing system models from a missing Session model", () => {
  assert.equal(resolveComposerRunAction({
    ...baseInput,
    hasModel: false,
    modelsAvailable: false,
  }).noModelReason, "no-system-models");
  assert.equal(resolveComposerRunAction({ ...baseInput, hasModel: false }).noModelReason, "no-session-model");
  assert.equal(resolveComposerRunAction(baseInput).noModelReason, null);
});

test("renders visible and actionable notices for both missing-model states", () => {
  const noSystemModels = renderToStaticMarkup(createElement(ComposerNoModelNotice, {
    onOpenModelSettings: () => undefined,
    reason: "no-system-models",
  }));
  assert.match(noSystemModels, /id="composer-no-model-notice"/);
  assert.match(noSystemModels, /No models are configured\./);
  assert.match(noSystemModels, /Open Model registry/);

  const noSessionModel = renderToStaticMarkup(createElement(ComposerNoModelNotice, {
    onOpenModelSettings: () => undefined,
    reason: "no-session-model",
  }));
  assert.match(noSessionModel, /No Task model is selected\./);
  assert.match(noSessionModel, /Choose one below before running\./);
});

test("renders Stop as a non-submit control and Add to queue as the submit control", () => {
  const running = renderToStaticMarkup(createElement(ComposerRunButton, {
    action: { noModelReason: null, runDisabled: false, runLabel: "Add to queue", stopDisabled: false, stopVisible: true },
    onStop: () => undefined,
  }));
  assert.match(running, /type="button"/);
  assert.match(running, /aria-label="Stop the current run"/);
  assert.match(running, / Stop<\/button>/);
  assert.match(running, /type="submit"/);
  assert.match(running, / Add to queue<\/button>/);

  const stopping = renderToStaticMarkup(createElement(ComposerRunButton, {
    action: { noModelReason: null, runDisabled: false, runLabel: "Add to queue", stopDisabled: true, stopVisible: true },
    onStop: () => undefined,
  }));
  assert.match(stopping, /disabled/);
  assert.match(stopping, / Stopping\.\.\.<\/button>/);

  const run = renderToStaticMarkup(createElement(ComposerRunButton, {
    action: { noModelReason: null, runDisabled: false, runLabel: "Run analysis", stopDisabled: false, stopVisible: false },
    onStop: () => undefined,
  }));
  assert.match(run, /type="submit"/);
  assert.match(run, / Run analysis<\/button>/);
});

test("associates a disabled Run button with the visible missing-model notice", () => {
  const run = renderToStaticMarkup(createElement(ComposerRunButton, {
    action: {
      noModelReason: "no-system-models",
      runDisabled: true,
      runLabel: "Run analysis",
      stopDisabled: false,
      stopVisible: false,
    },
    onStop: () => undefined,
  }));
  assert.match(run, /aria-describedby="composer-no-model-notice"/);
  assert.match(run, /title="Run unavailable: no models are configured\./);
});

function queuedRun(id: string): SessionRun {
  return {
    annotationIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    prompt: `queued prompt ${id}`,
    queueOrder: 2,
    references: [],
    sessionId: "session-a",
    settingsSnapshot: {
      enabledConnectorIds: [],
      enabledSkillIds: [],
      modelId: "model-a",
      semanticReviewEnabled: false,
    },
    status: "queued",
  };
}

test("queued run rows expose a run-specific cancel control", () => {
  const html = renderToStaticMarkup(createElement(QueuedRunsPanel, {
    cancellingRunIds: new Set(["run-b"]),
    onCancel: () => undefined,
    runs: [queuedRun("run-a"), queuedRun("run-b")],
  }));

  assert.match(html, /aria-label="Queued runs"/);
  assert.match(html, /queued prompt run-a/);
  assert.match(html, /aria-label="Cancel queued run"/);
  assert.match(html, /disabled/);
});

test("queued cancel feedback reflects the returned run status", () => {
  assert.deepEqual(queuedCancelToast("cancelled"), { title: "Queued run cancelled", tone: "info" });
  assert.deepEqual(queuedCancelToast("running"), {
    detail: "The queued run has already started; use Stop to cancel the active run.",
    title: "Run already started",
    tone: "info",
  });
  assert.deepEqual(queuedCancelToast("completed"), { title: "Run already finished", tone: "info" });
});
