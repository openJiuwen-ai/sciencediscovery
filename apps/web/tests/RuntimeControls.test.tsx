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

import { QuotaSettingsEditor, TimeoutSettingsEditor } from "../src/RuntimeControls.js";

test("renders all product timeouts with explicit Unlimited controls", () => {
  const html = renderToStaticMarkup(createElement(TimeoutSettingsEditor, {
    onChange: () => undefined,
    settings: {
      gatewayIdleTimeoutMs: 240_000,
      gatewayTurnTimeoutMs: 0,
      kernelIdleTimeoutMs: 0,
      permissionWaitTimeoutMs: 0,
      runnerExecTimeoutMs: 0,
    },
  }));

  assert.match(html, /Agent idle/);
  assert.match(html, /Agent turn/);
  assert.match(html, /no streamed output or progress for too long/);
  assert.match(html, /model, tools, and streamed output/);
  assert.doesNotMatch(html, /Gateway (?:idle|turn|produces)/);
  assert.match(html, /Runner execution/);
  assert.match(html, /Kernel idle/);
  assert.match(html, /Permission wait/);
  assert.equal((html.match(/>Unlimited</g) ?? []).length, 5);
  assert.match(html, /Agent idle timeout in seconds/);
  assert.match(html, /value="240"/);
  assert.match(html, /Draft: 4 min/);
  assert.match(html, /Internal request-signature safety windows are not changed here/);
});


test("renders runner quota controls with GiB and Unlimited", () => {
  const html = renderToStaticMarkup(createElement(QuotaSettingsEditor, {
    onChange: () => undefined,
    settings: {
      runnerMaxOutputBytes: 1_073_741_824,
      runnerMaxWorkspaceBytes: 10_737_418_240,
      uploadMaxFileBytes: 1_073_741_824,
      uploadMaxRequestBytes: 10_737_418_240,
    },
  }));
  assert.match(html, /Quotas/);
  assert.match(html, /Workspace total/);
  assert.match(html, /Upload per file/);
  assert.match(html, /Upload per request/);
  assert.match(html, /Workspace total/);
  assert.match(html, /Execution output/);
  assert.match(html, /Draft: 10 GiB/);
  assert.match(html, /Draft: 1 GiB/);
  assert.match(html, /aria-label="Upload per-file quota in GiB"/);
  assert.match(html, /aria-label="Upload per-request quota in GiB"/);
  assert.match(html, /aria-label="Runner output budget in GiB"/);
  assert.equal((html.match(/>Unlimited</g) ?? []).length, 4);
});
