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

import {
  addToastToQueue,
  removeToastFromQueue,
  toastAutoDismissDelay,
  ToastViewport,
  type Toast,
} from "../src/Toasts.js";

const toasts: Toast[] = [
  { detail: "Global scope", id: 1, title: "Settings saved", tone: "success" },
  { id: 2, title: "Run failed", tone: "error" },
];

test("renders toast tones, titles, details, and dismiss actions", () => {
  const html = renderToStaticMarkup(createElement(ToastViewport, { onDismiss: () => undefined, toasts }));

  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /class="toast success"/);
  assert.match(html, /class="toast error"/);
  assert.match(html, /Settings saved/);
  assert.match(html, /Global scope/);
  assert.match(html, /aria-label="Dismiss notification"/);
  assert.match(html, /title="Dismiss notification"/);
});

test("renders nothing when the toast queue is empty", () => {
  const html = renderToStaticMarkup(createElement(ToastViewport, { onDismiss: () => undefined, toasts: [] }));

  assert.equal(html, "");
});

test("error notifications never receive an automatic dismiss delay", () => {
  assert.equal(toastAutoDismissDelay("error"), undefined);
  assert.equal(toastAutoDismissDelay("success"), 4_500);
  assert.equal(toastAutoDismissDelay("info"), 4_500);
});

test("transient queue pressure never evicts an existing error", () => {
  const persistent: Toast = { id: 1, title: "A task model is required", tone: "error" };
  let queue = addToastToQueue([], persistent);

  for (let id = 2; id <= 7; id += 1) {
    queue = addToastToQueue(queue, { id, title: `Saved ${id}`, tone: "success" });
  }

  assert.deepEqual(queue.filter((toast) => toast.tone === "error"), [persistent]);
  assert.deepEqual(queue.filter((toast) => toast.tone !== "error").map((toast) => toast.id), [4, 5, 6, 7]);
});

test("a rejected token cannot grow the notification column past a dialog", () => {
  // One wrong access token fails every startup request with the same body, and
  // each wrong-token save re-runs them all. Before duplicates collapsed, this
  // reached ten persistent toasts and covered the settings dialog footer.
  const unauthorized = (id: number): Toast => ({ detail: "Unauthorized", id, title: "Request error", tone: "error" });
  let queue: Toast[] = [];

  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (let request = 0; request < 5; request += 1) {
      queue = addToastToQueue(queue, unauthorized(attempt * 5 + request + 1));
    }
  }

  assert.deepEqual(queue, [unauthorized(1)]);
});

test("a different failure still gets its own notification", () => {
  let queue = addToastToQueue([], { detail: "Unauthorized", id: 1, title: "Request error", tone: "error" });

  queue = addToastToQueue(queue, { detail: "Gateway is unavailable", id: 2, title: "Request error", tone: "error" });
  queue = addToastToQueue(queue, { detail: "Could not save model", id: 3, title: "Settings error", tone: "error" });

  assert.deepEqual(queue.map((toast) => toast.detail), ["Unauthorized", "Gateway is unavailable", "Could not save model"]);
});

test("a failure that recurs after the user dismissed it notifies again", () => {
  const failure: Toast = { detail: "Unauthorized", id: 1, title: "Request error", tone: "error" };
  const queue = addToastToQueue([], failure);

  const afterDismiss = removeToastFromQueue(queue, failure.id);
  const repeated = addToastToQueue(afterDismiss, { ...failure, id: 2 });

  assert.deepEqual(repeated.map((toast) => toast.id), [2]);
});

test("collapsing duplicates leaves transient eviction untouched", () => {
  let queue = addToastToQueue([], { id: 1, title: "Run failed", tone: "error" });

  for (let id = 2; id <= 7; id += 1) {
    queue = addToastToQueue(queue, { detail: `Session ${id}`, id, title: "Session created", tone: "success" });
  }

  assert.deepEqual(queue.filter((toast) => toast.tone === "error").map((toast) => toast.id), [1]);
  assert.deepEqual(queue.filter((toast) => toast.tone !== "error").map((toast) => toast.id), [4, 5, 6, 7]);
});

test("an explicit dismiss removes only the selected error", () => {
  const queue: Toast[] = [
    { id: 1, title: "First failure", tone: "error" },
    { id: 2, title: "Second failure", tone: "error" },
  ];

  assert.deepEqual(removeToastFromQueue(queue, 1), [queue[1]]);
});
