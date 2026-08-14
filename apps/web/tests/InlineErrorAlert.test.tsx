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

import { InlineErrorAlert, updateInlineErrors } from "../src/InlineErrorAlert.js";

test("keeps every displayed dialog error until an explicit clear", () => {
  const first = updateInlineErrors([], "Could not load settings");
  const second = updateInlineErrors(first, "Could not save settings");

  assert.deepEqual(second, ["Could not load settings", "Could not save settings"]);
  assert.equal(updateInlineErrors(second, "Could not save settings"), second);
  assert.deepEqual(updateInlineErrors(second), []);
});

test("renders dialog-owned error details with alert semantics and an explicit dismiss button", () => {
  const html = renderToStaticMarkup(createElement(InlineErrorAlert, {
    detail: "A custom proxy URL is required in custom proxy mode",
    onDismiss: () => undefined,
  }));

  assert.match(html, /role="alert"/);
  assert.match(html, /A custom proxy URL is required in custom proxy mode/);
  assert.match(html, /aria-label="Dismiss error"/);
  assert.match(html, /type="button"/);
});
