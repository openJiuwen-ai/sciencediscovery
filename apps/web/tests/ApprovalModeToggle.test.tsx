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

import { ApprovalModeToggle, nextApprovalMode } from "../src/composer/ApprovalModeToggle.js";

test("cycles between ask and always allow", () => {
  assert.equal(nextApprovalMode("ask_for_dangerous"), "always_allow");
  assert.equal(nextApprovalMode("always_allow"), "ask_for_dangerous");
});

test("ask mode shows the guarded shield with a hover explanation", () => {
  const markup = renderToStaticMarkup(createElement(ApprovalModeToggle, {
    mode: "ask_for_dangerous",
    onChange: () => undefined,
  }));
  assert.match(markup, /aria-label="Approvals: Ask for dangerous actions"/);
  assert.match(markup, /aria-pressed="false"/);
  assert.match(markup, /title="Ask for dangerous actions: risky tool calls pause for your approval\. Click to switch to always allow\."/);
  assert.match(markup, /class="approval-mode-toggle"/);
  assert.doesNotMatch(markup, /disabled/);
  assert.doesNotMatch(markup, /<select/);
});

test("always allow mode switches the visual state and explanation", () => {
  const markup = renderToStaticMarkup(createElement(ApprovalModeToggle, {
    mode: "always_allow",
    onChange: () => undefined,
  }));
  assert.match(markup, /aria-label="Approvals: Always allow"/);
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /class="approval-mode-toggle always-allow"/);
  assert.match(markup, /title="Always allow: every tool call is approved automatically\. Click to switch back to asking for dangerous actions\."/);
});

test("archived sessions disable the toggle", () => {
  const markup = renderToStaticMarkup(createElement(ApprovalModeToggle, {
    disabled: true,
    mode: "ask_for_dangerous",
    onChange: () => undefined,
  }));
  assert.match(markup, /disabled=""/);
});
