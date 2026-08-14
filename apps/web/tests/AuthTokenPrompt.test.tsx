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

import { ApiClient } from "../src/api.js";
import { createAuthTokenPromptGate } from "../src/auth-token-prompt.js";
import { addToastToQueue, type Toast } from "../src/Toasts.js";

/** Run one API call against a stubbed response and report whether the client
 *  treated it as "the server rejected this token". */
async function authFailuresFor(response: () => Response | Promise<Response>): Promise<number> {
  const previousFetch = globalThis.fetch;
  let failures = 0;
  globalThis.fetch = async () => await response();
  try {
    await new ApiClient("wrong-token", () => { failures += 1; }).listProjects().catch(() => undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
  return failures;
}

test("a rejected token is reported as an authentication failure", async () => {
  const failures = await authFailuresFor(() => Response.json({ error: "Unauthorized" }, { status: 401 }));
  assert.equal(failures, 1);
});

test("a server fault is not mistaken for a bad token", async () => {
  const failures = await authFailuresFor(() => Response.json({ error: "boom" }, { status: 500 }));
  assert.equal(failures, 0);
});

test("a missing resource is not mistaken for a bad token", async () => {
  const failures = await authFailuresFor(() => Response.json({ error: "gone" }, { status: 404 }));
  assert.equal(failures, 0);
});

test("a transport failure is not mistaken for a bad token", async () => {
  const failures = await authFailuresFor(() => { throw new TypeError("Failed to fetch"); });
  assert.equal(failures, 0);
});

test("an accepted token reports nothing", async () => {
  const failures = await authFailuresFor(() => Response.json([], { status: 200 }));
  assert.equal(failures, 0);
});

test("streaming endpoints report a rejected token too", async () => {
  const previousFetch = globalThis.fetch;
  let failures = 0;
  globalThis.fetch = async () => Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await new ApiClient("wrong-token", () => { failures += 1; })
      .subscribeRunEvents("session-a", "run-a", 0, () => undefined)
      .catch(() => undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(failures, 1);
});

test("one wrong token opens the dialog once, however many requests fail", () => {
  const gate = createAuthTokenPromptGate();

  assert.equal(gate.shouldPrompt("wrong-token"), true);
  assert.equal(gate.shouldPrompt("wrong-token"), false);
  assert.equal(gate.shouldPrompt("wrong-token"), false);
});

test("the next token the user tries earns a fresh prompt", () => {
  const gate = createAuthTokenPromptGate();
  gate.shouldPrompt("");

  assert.equal(gate.shouldPrompt("still-wrong"), true);
  assert.equal(gate.shouldPrompt("still-wrong"), false);
});

test("a token that starts working never reopens the dialog", async () => {
  const gate = createAuthTokenPromptGate();
  gate.shouldPrompt("wrong-token");
  const previousFetch = globalThis.fetch;
  let prompts = 0;

  globalThis.fetch = async () => Response.json([], { status: 200 });
  try {
    const client = new ApiClient("correct-token", () => {
      if (gate.shouldPrompt("correct-token")) prompts += 1;
    });
    assert.deepEqual(await client.listProjects(), []);
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(prompts, 0);
});

/** The App wiring in miniature: every failed request reports through `setError`,
 *  which pushes a persistent error toast, and a 401 additionally arms the token
 *  dialog. Startup issues several independent calls, so one rejected token fails
 *  all of them at once. */
function recoveryHarness() {
  const gate = createAuthTokenPromptGate();
  const state = { dialogOpens: 0, toasts: [] as Toast[] };
  let nextToastId = 1;
  const setError = (detail: string): void => {
    state.toasts = addToastToQueue(state.toasts, {
      detail,
      id: nextToastId,
      title: "Request error",
      tone: "error",
    });
    nextToastId += 1;
  };
  const attempt = async (token: string, accepted: boolean): Promise<void> => {
    globalThis.fetch = async () => (accepted
      ? Response.json([], { status: 200 })
      : Response.json({ error: "Unauthorized" }, { status: 401 }));
    const client = new ApiClient(token, () => {
      if (gate.shouldPrompt(token)) state.dialogOpens += 1;
    });
    await Promise.all(Array.from({ length: 5 }, async () => {
      await client.listProjects().catch((reason: Error) => setError(reason.message));
    }));
  };
  return { attempt, state };
}

test("correcting a token after wrong attempts never needs the notifications cleared", async () => {
  const previousFetch = globalThis.fetch;
  const { attempt, state } = recoveryHarness();
  try {
    await attempt("", false);            // cold start with no token
    await attempt("wrong-token-a", false); // user saves a wrong token
    await attempt("wrong-token-b", false); // and another one

    // One notification for one condition, however many requests failed: the
    // column cannot reach the dialog footer the user has to click.
    assert.equal(state.toasts.length, 1);
    assert.equal(state.dialogOpens, 3);

    await attempt("correct-token", true);

    assert.equal(state.toasts.length, 1);
    assert.equal(state.dialogOpens, 3);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("an unrelated failure during recovery keeps its own notification", async () => {
  const previousFetch = globalThis.fetch;
  const { attempt, state } = recoveryHarness();
  try {
    await attempt("wrong-token", false);
    globalThis.fetch = async () => Response.json({ error: "Gateway is unavailable" }, { status: 500 });
    const client = new ApiClient("wrong-token", () => { state.dialogOpens += 1; });
    await client.listProjects().catch((reason: Error) => {
      state.toasts = addToastToQueue(state.toasts, {
        detail: reason.message,
        id: 99,
        title: "Request error",
        tone: "error",
      });
    });

    assert.deepEqual(state.toasts.map((toast) => toast.detail), ["Unauthorized", "Gateway is unavailable"]);
    assert.equal(state.dialogOpens, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
