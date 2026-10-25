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
import { ApiClient } from "../src/api/client.js";
import { InlineErrorAlert } from "../src/InlineErrorAlert.js";
import { ToastViewport } from "../src/Toasts.js";
import { ErrorBoundary } from "../src/ErrorBoundary.js";
import { reduceRunTimeline, RunTimeline } from "../src/RunTimeline.js";
import { errorDiagnosticIds, rememberErrorDiagnostic } from "../src/error-diagnostics.js";

test("error toast and inline alert share both diagnostic controls; success toasts do not", () => {
  for (const node of [
    createElement(InlineErrorAlert, { detail: "Save failed" }),
    createElement(ToastViewport, { toasts: [{ id: 1, title: "Failed", tone: "error", detail: "Save failed" }], onDismiss() {} }),
  ]) {
    const html = renderToStaticMarkup(node);
    assert.match(html, /Copy key diagnostics/); assert.match(html, /Open GitHub issue/);
    assert.doesNotMatch(html, /href="https:\/\/github/);
  }
  assert.doesNotMatch(renderToStaticMarkup(createElement(ToastViewport, { toasts: [{ id: 1, title: "Saved", tone: "success" }], onDismiss() {} })), /Copy key diagnostics/);
});

test("panel render failure and collapsed tool failure remain reportable without copying tool payloads", () => {
  const boundary = new ErrorBoundary({ children: null, label: "Panel" });
  boundary.state = { message: "Render failed" };
  assert.match(renderToStaticMarkup(boundary.render()), /Copy key diagnostics/);
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries: [{ id: "entry", type: "tool", expanded: false, trace: { id: "tool-1", name: "run_shell", status: "failed", summary: "Command failed", output: "private research output", args: { command: "private research command" } } }],
    isRunning: false, onToggle() {}, workspaceSessionId: "session-1", diagnosticRunId: "run-1",
  }));
  assert.match(html, /Copy key diagnostics/);
  assert.match(html, /Open GitHub issue/);
});

test("correlation registry is bounded and contains identifiers only", () => {
  rememberErrorDiagnostic("specific failure", { requestId: "req-1", sessionId: "s1" });
  assert.deepEqual(errorDiagnosticIds("specific failure"), { requestId: "req-1", sessionId: "s1" });
  for (let i = 0; i < 31; i++) rememberErrorDiagnostic(`error-${i}`, { requestId: `req-${i}` });
  assert.deepEqual(errorDiagnosticIds("specific failure"), {});
  assert.deepEqual(errorDiagnosticIds("error-30"), { requestId: "req-30" });
});


test("a rejected diagnostic read preserves the original authentication error surface", async () => {
  const original = globalThis.fetch;
  let prompts = 0;
  globalThis.fetch = async () => new Response('{"error":"Unauthorized"}', { status: 401 });
  try {
    await assert.rejects(new ApiClient("bad-token", () => { prompts++; }).getErrorDiagnostics({ requestId: "req-1" }), /unavailable/);
    assert.equal(prompts, 0);
  } finally { globalThis.fetch = original; }
});


test("tool records remain direct timeline children beside the assistant identity", () => {
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries: [{ id: "entry", type: "tool", expanded: false, trace: { id: "tool-1", name: "run_shell", status: "completed", summary: "Done" } }],
    isRunning: false, onToggle() {},
  }));
  assert.match(html, /<\/header><details class="timeline-disclosure tool completed process-record"/);
});

test("failed tools display recovery guidance and retain the original error for copying", () => {
  const entries = reduceRunTimeline([], { type: "tool.started", trace: { id: "tool-1", name: "run_shell", status: "running" } });
  const [failed] = reduceRunTimeline(entries, { type: "run.failed", errorCode: "unauthorized", error: "Provider rejected the request" });
  assert.equal(failed?.type, "tool");
  if (failed?.type !== "tool") return;
  assert.equal(failed.diagnosticError, "Provider rejected the request");
  assert.notEqual(failed.trace.summary, failed.diagnosticError);
});
