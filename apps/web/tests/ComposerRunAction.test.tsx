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


import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionRun } from "@sciencediscovery/schema";

import { ComposerNoModelNotice, ComposerRunButton, QueuedRunsPanel, queuedCancelToast, resolveComposerRunAction, shouldShowModelConfigurationCard } from "../src/App.js";

const baseInput = {
  activeSessionId: "session-b",
  hasModel: true,
  message: "Summarize the dataset",
  modelsAvailable: true,
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

test("a running Reviewer does not expose the main Agent Stop control", () => {
  assert.deepEqual(
    resolveComposerRunAction(baseInput),
    { noModelReason: null, runDisabled: false, runLabel: "Run analysis", stopDisabled: false, stopVisible: false },
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

test("a draft can request configuration when its Session has no model", () => {
  assert.equal(resolveComposerRunAction({ ...baseInput, message: "  " }).runDisabled, true);
  assert.equal(resolveComposerRunAction({ ...baseInput, hasModel: false, message: "  " }).runLabel, "Run analysis");
  assert.equal(resolveComposerRunAction({ ...baseInput, hasModel: false }).runDisabled, false);
  assert.equal(resolveComposerRunAction({ ...baseInput, hasModel: false }).runLabel, "Configure and continue");
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

test("the configuration card appears only after a draft is submitted for this Session", () => {
  assert.equal(shouldShowModelConfigurationCard("session-b", undefined, "no-session-model", false, false), false);
  assert.equal(shouldShowModelConfigurationCard("session-b", "session-b", "no-session-model", false, false), true);
  assert.equal(shouldShowModelConfigurationCard("session-b", "session-a", "no-session-model", false, false), false);
  assert.equal(shouldShowModelConfigurationCard("session-b", "session-b", null, false, false), false);
  assert.equal(shouldShowModelConfigurationCard("session-b", "session-b", "no-session-model", true, false), false);
  assert.equal(shouldShowModelConfigurationCard("session-b", "session-b", "no-session-model", false, true), false);
});

test("a missing-model notice keeps the manual configuration entry available", () => {
  for (const reason of ["no-session-model", "no-system-models"] as const) {
    const notice = renderToStaticMarkup(createElement(ComposerNoModelNotice, {
      onOpenConfiguration: () => undefined,
      reason,
    }));
    assert.match(notice, /Configure in conversation<\/button>/);
    assert.match(notice, /Ask a question or configure one here\./);
  }
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

test("a missing-model draft offers configuration without a duplicate notice", () => {
  const run = renderToStaticMarkup(createElement(ComposerRunButton, {
    action: {
      noModelReason: "no-system-models",
      runDisabled: false,
      runLabel: "Configure and continue",
      stopDisabled: false,
      stopVisible: false,
    },
    onStop: () => undefined,
  }));
  assert.match(run, /Configure and continue<\/button>/);
  assert.doesNotMatch(run, /composer-no-model-notice/);
  assert.doesNotMatch(run, /disabled/);
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
