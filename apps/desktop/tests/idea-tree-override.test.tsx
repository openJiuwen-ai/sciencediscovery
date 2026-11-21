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
// Classic JSX runtime under tsx, so React has to be in scope here.
import React from "react";

import { IdeaTreeOverrideDialog } from "../src/views/idea/IdeaTreeOverrideDialog.js";
import { act, create } from "./support/dom-renderer.js";

/** The global settings the card reads, and a client that records every call. */
const GLOBAL = {
  templateId: "scientific-hypothesis-general/v1",
  explorationIntensity: "standard",
  scoreDirection: "maximize",
  maxTokens: null,
  maxDepth: 5,
  maxNodes: 100,
};

function stubClient() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  return {
    calls,
    client: {
      request: async (path: string, init?: { body?: string; method?: string }) => {
        calls.push({
          method: init?.method ?? "GET",
          path,
          body: init?.body === undefined ? undefined : JSON.parse(init.body),
        });
        return GLOBAL;
      },
    } as never,
  };
}

/** Let the load's promise and the click's write settle. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(client: unknown, sessionId?: string) {
  const closed: number[] = [];
  let view: { toJSON: () => unknown; root: never; unmount: () => void };
  await act(async () => {
    view = create(
      <IdeaTreeOverrideDialog client={client as never} onClose={() => { closed.push(1); }} sessionId={sessionId} />,
    ) as never;
  });
  await flush();
  return { closed: () => closed.length, markup: () => JSON.stringify(view!.toJSON()), view: view! };
}

function click(view: { root: never }, label: string) {
  const buttons = (view.root as unknown as { findAllByType: (type: string) => { props: { children?: unknown; onClick?: () => void } }[] })
    .findAllByType("button");
  const target = buttons.find((node) => String(node.props.children) === label);
  assert.ok(target, `the ${label} button is drawn`);
  target!.props.onClick?.();
}

test("the card starts from the global settings and offers the five fields", async () => {
  const { client } = stubClient();
  const { markup, view } = await mount(client, "s1");
  try {
    for (const label of ["研究模板", "探索强度", "评分方向", "最大深度", "最大节点数"]) {
      assert.match(markup(), new RegExp(label), `${label} is offered`);
    }
    // The per-call cap #1281 removed is not offered any more.
    assert.doesNotMatch(markup(), /单次调用 token/);
    // The values shown are the global ones.
    assert.match(markup(), /"value":5/);
    assert.match(markup(), /"value":100/);
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("using the settings for this conversation writes the Session, never the global settings", async () => {
  const { calls, client } = stubClient();
  const { view } = await mount(client, "s1");
  try {
    await act(async () => { click(view, "只用于本次会话"); });
    await flush();
    assert.equal(calls.filter((call) => call.method === "PUT").length, 0, "no global write");
    const patch = calls.find((call) => call.method === "PATCH");
    assert.ok(patch, "the session is patched");
    assert.equal(patch!.path, "/api/sessions/s1");
    assert.deepEqual(
      Object.keys((patch!.body as { ideaTreeOverride: object }).ideaTreeOverride).sort(),
      ["explorationIntensity", "maxDepth", "maxNodes", "scoreDirection", "templateId"],
    );
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("overwriting the global settings writes them and touches no Session", async () => {
  const { calls, client } = stubClient();
  const { view } = await mount(client, "s1");
  try {
    await act(async () => { click(view, "覆盖全局设置"); });
    await flush();
    assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "no session write");
    const put = calls.find((call) => call.method === "PUT");
    assert.ok(put, "the global settings are written");
    assert.equal(put!.path, "/api/settings/idea-tree");
    const body = put!.body as Record<string, unknown>;
    // `maxTokens` (the per-research budget) still travels; the per-call cap is gone.
    assert.equal(body.maxTokens, null);
    assert.equal("maxTokensPerCall" in body, false);
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("cancelling writes nothing and closes", async () => {
  const { calls, client } = stubClient();
  const { closed, view } = await mount(client, "s1");
  try {
    await act(async () => { click(view, "取消"); });
    assert.equal(calls.filter((call) => call.method !== "GET").length, 0, "nothing written");
    assert.equal(closed(), 1, "the dialog closed");
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("with no conversation the session write is refused and said so", async () => {
  const { client } = stubClient();
  const { markup, view } = await mount(client, undefined);
  try {
    assert.match(markup(), /打开一个会话后/);
    // Exactly one control is disabled in this state: the one that would write a
    // Session that does not exist. Cancel and the global write stay available.
    assert.equal((markup().match(/"disabled":true/g) ?? []).length, 1,
      "only the session write is refused");
    assert.match(markup(), /只用于本次会话/);
    assert.match(markup(), /覆盖全局设置/);
  } finally {
    await act(async () => { view.unmount(); });
  }
});
