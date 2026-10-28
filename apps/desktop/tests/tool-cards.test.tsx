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

// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { createTest } from "../../../test/support/tagged/compat.mjs";
import type { ApiClient } from "../src/api/client.js";
import type { PermissionRequest, ToolTrace } from "../src/api/types.js";
import { TEXT } from "../src/text.js";
import { PermissionCard } from "../src/views/PermissionCard.js";
import { ToolCard } from "../src/views/ToolCard.js";
import { ToolDetail } from "../src/views/ToolDetail.js";

const { describe, it } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

/**
 * A client that fails loudly. The cards must not read anything on their own —
 * the tool result is fetched when the card is opened, and a static render never
 * opens one — so any call reaching here is a bug in the card, not in the test.
 */
const client = new Proxy({} as ApiClient, {
  get: () => () => Promise.reject(new Error("the card made a request it should not have")),
});

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

function trace(overrides: Partial<ToolTrace> = {}): ToolTrace {
  return { id: "c1", name: "run_python", status: "completed", ...overrides };
}

function card(props: Partial<Parameters<typeof ToolCard>[0]> = {}): string {
  return render(
    <ToolCard
      authorized={false}
      client={client}
      sessionId="s1"
      trace={trace()}
      {...props}
    />,
  );
}

describe("a tool call says what happened in its summary", () => {
  it("names the tool while it runs and says it was called once it is done", () => {
    assert.match(card({ trace: trace({ status: "running" }) }), /run_python/);
    assert.match(card(), new RegExp(TEXT.conversation.toolCompleted("run_python")));
    assert.match(card({ trace: trace({ status: "failed" }) }), new RegExp(TEXT.conversation.toolFailed("run_python")));
  });

  it("labels every card as a tool call", () => {
    assert.match(card(), new RegExp(TEXT.conversation.toolCall));
  });

  it("mentions an authorization only when one covered the call", () => {
    assert.doesNotMatch(card(), new RegExp(TEXT.conversation.authorized));
    assert.match(card({ authorized: true }), new RegExp(TEXT.conversation.authorized));
  });

  it("shows the input it was given", () => {
    assert.match(card({ trace: trace({ args: { code: "print(1)" } }) }), /print\(1\)/);
  });
});

describe("a card with no result yet says which of the three reasons it is", () => {
  it("says the tool is running, not that it produced nothing", () => {
    const html = card({ trace: trace({ status: "running" }) });
    assert.match(html, new RegExp(TEXT.conversation.toolRunning));
    assert.doesNotMatch(html, new RegExp(TEXT.conversation.noOutput));
  });

  it("says the result is still loading when a substream is named", () => {
    const html = card({ trace: trace({ outputStream: "tool-c1" }) });
    assert.match(html, new RegExp(TEXT.conversation.loadingResult));
    assert.doesNotMatch(html, new RegExp(TEXT.conversation.noOutput));
  });

  it("says the tool finished without output when there is nowhere to read from", () => {
    assert.match(card(), new RegExp(TEXT.conversation.noOutput));
  });

  it("splits an inline result into sections rather than showing it as one blob", () => {
    const html = card({ trace: trace({ output: "stdout: 3\nstderr: wobble" }) });
    assert.match(html, /stdout/);
    assert.match(html, /stderr/);
    assert.doesNotMatch(html, new RegExp(TEXT.conversation.noOutput));
  });

  it("reports an inline result and a truncation note together", () => {
    const html = card({ trace: trace({ output: "stdout: 3", outputTruncated: true }) });
    assert.match(html, new RegExp(TEXT.conversation.outputTruncated));
  });
});

describe("a tool call's input and result are tiles, not another row of folds", () => {
  it("draws each block as a labeled code tile", () => {
    // One more click to read the result the card was opened for is the thing
    // the handoff removes: the tiles are open by construction.
    const html = card({ trace: trace({ args: { command: "ls -l" }, output: "stdout: a\nstderr: b" }) });
    assert.match(html, /class="tool-io-code-text"/);
    // The plural `tool-io-sections` is the card's own body; the singular class
    // was the nested fold that is gone.
    assert.doesNotMatch(html, /tool-io-section"/);
    assert.match(html, /ls -l/);
    assert.match(html, /stdout/);
    assert.match(html, /stderr/);
  });

  it("makes a tile a door to the panel when one is wired", () => {
    const html = card({
      onOpenTool: () => undefined,
      trace: trace({ id: "c9", name: "run_python", output: "stdout: 3" }),
    });
    assert.match(html, /role="button"/);
    assert.match(html, new RegExp(TEXT.conversation.openInPanel));
  });

  it("leaves the tiles plain where there is no panel to open", () => {
    const html = card({ trace: trace({ output: "stdout: 3" }) });
    assert.doesNotMatch(html, /role="button"/);
    assert.doesNotMatch(html, new RegExp(TEXT.conversation.openInPanel));
  });
});

describe("the panel shows the block the reader pressed", () => {
  it("draws the full text with the same label and no second door", () => {
    const html = render(
      <ToolDetail
        detail={{
          content: "the whole output\nsecond line",
          id: "result",
          label: TEXT.conversation.toolOutput,
          name: "run_python",
          status: "completed",
          toolId: "c1",
        }}
      />,
    );
    assert.match(html, /class="tool-io-code-text"/);
    assert.match(html, /the whole output\nsecond line/);
    assert.match(html, new RegExp(TEXT.conversation.toolOutput));
    assert.doesNotMatch(html, /role="button"/);
    assert.doesNotMatch(html, new RegExp(TEXT.conversation.openInPanel));
  });
});

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    action: "sandbox",
    createdAt: "2026-10-20T00:00:00.000Z",
    id: "p1",
    resource: "python:run",
    state: "pending",
    summary: "运行一段代码",
    toolCallId: "c1",
    ...overrides,
  };
}

function permission(props: Partial<Parameters<typeof PermissionCard>[0]> = {}): string {
  return render(
    <PermissionCard
      busy={false}
      interactive
      onDecision={() => undefined}
      request={request()}
      {...props}
    />,
  );
}

describe("a pending authorization offers exactly three answers", () => {
  it("shows the ask, the resource and all three buttons", () => {
    const html = permission();
    assert.match(html, new RegExp(TEXT.permission.required));
    assert.match(html, /运行一段代码/);
    assert.match(html, /python:run/);
    for (const label of [TEXT.permission.allowOnce, TEXT.permission.allowMatching, TEXT.permission.deny]) {
      assert.match(html, new RegExp(label));
    }
  });

  it("keeps the request's own identifiers in the detail fold", () => {
    const html = permission();
    assert.match(html, /c1/);
    assert.match(html, new RegExp(TEXT.permission.toolCall));
  });

  it("leaves the buttons live while a decision can still be made", () => {
    assert.doesNotMatch(permission(), /disabled/);
  });

  it("disables them while one is in flight, and once the run is over", () => {
    assert.match(permission({ busy: true }), /disabled/);
    assert.match(permission({ interactive: false }), /disabled/);
  });

  it("renders nothing at all once the request has been answered", () => {
    assert.equal(permission({ request: request({ state: "denied" }) }), "");
    assert.equal(permission({ request: request({ state: "allowed" }) }), "");
  });
});
