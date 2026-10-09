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
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { useMemorySubgraph } from "../src/MemoryGraphView.js";
import { ApiClient } from "../src/api.js";
import { ApiRequestError, isAuthFailure } from "../src/api/auth.js";
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
 *  which reserves 401 for the token dialog and toasts other errors. Startup issues several independent calls, so one rejected token fails
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
      await client.listProjects().catch((reason: Error) => { if (!isAuthFailure(reason)) setError(reason.message); });
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

    // The Connection prompt is the only feedback for local authentication.
    assert.equal(state.toasts.length, 0);
    assert.equal(state.dialogOpens, 3);

    await attempt("correct-token", true);

    assert.equal(state.toasts.length, 0);
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

    assert.deepEqual(state.toasts.map((toast) => toast.detail), ["Gateway is unavailable"]);
    assert.equal(state.dialogOpens, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

for (const failure of ["401", "500", "network"] as const) {
  test(`an existing session's next memory poll routes ${failure} without losing its status`, async (context) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    context.mock.timers.enable({ apis: ["setInterval"] });
    const previousFetch = globalThis.fetch;
    let failed = false;
    let graphRequests = 0;
    const state = { connection: false, toasts: [] as string[], forwarded: [] as (Error | string)[] };
    const gate = createAuthTokenPromptGate();
    globalThis.fetch = async (url) => {
      if (String(url).includes("subgraph")) graphRequests += 1;
      if (!failed) return Response.json({ nodes: [], edges: [], memoryGraph: "ok" });
      if (failure === "network") throw new TypeError("Failed to fetch");
      return Response.json({ error: failure === "401" ? "Unauthorized" : "Memory unavailable" }, { status: Number(failure) });
    };
    const client = new ApiClient("session-token", () => {
      if (gate.shouldPrompt("session-token")) state.connection = true;
    });
    function Session() {
      useMemorySubgraph(client, "existing-session", "unchanged", (reason) => {
        state.forwarded.push(reason);
        if (!isAuthFailure(reason)) state.toasts.push(reason instanceof Error ? reason.message : reason);
      }, false);
      return null;
    }
    let view: ReactTestRenderer | undefined;
    try {
      await act(async () => { view = create(createElement(Session)); });
      assert.equal(graphRequests, 1);
      assert.equal(state.connection, false);
      failed = true;
      // Exercise two actual timer ticks, not a cold mount with a bad token.
      for (let i = 0; i < 2; i += 1) {
        await act(async () => { context.mock.timers.tick(8_000); });
      }
      assert.equal(graphRequests, 3);
      if (failure === "401") {
        assert.deepEqual(state.toasts, [], "401 must leave Connection as the only authentication prompt");
        assert.equal(state.connection, true);
        assert.ok(state.forwarded.every(isAuthFailure), "the global reporter must receive the HTTP status");
      } else {
        assert.equal(state.connection, false);
        assert.deepEqual(state.toasts, Array(2).fill(failure === "500" ? "Memory unavailable" : "Failed to fetch"));
      }
    } finally {
      if (view) await act(async () => view!.unmount());
      globalThis.fetch = previousFetch;
      context.mock.timers.reset();
    }
  });
}

test("authentication routing never infers status from Unauthorized text", () => {
  for (const reason of ["Unauthorized", new Error("Unauthorized"), new ApiRequestError("Unauthorized", 500)]) {
    assert.equal(isAuthFailure(reason), false);
  }
});
