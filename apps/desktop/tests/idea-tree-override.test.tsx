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

/** What the Session has pinned; a case can change it before mounting. */
let SESSION_OVERRIDES: Record<string, unknown> = {};

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
        // The card reads two records: the deployment's Idea Tree settings, and
        // the Session's own (which carries the override).
        if (path.endsWith("/settings")) return { overrides: { ideaTreeOverride: SESSION_OVERRIDES }, sources: {}, effective: {} };
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
    // The heading names the feature the way the Chinese interface does.
    const heading = view.root.findByProps({ id: "idea-tree-override-title" });
    assert.equal(heading.children.join(""), "研究思路树参数");
    // The per-call cap #1281 removed is not offered any more.
    assert.doesNotMatch(markup(), /单次调用 token/);
    // The values shown are the global ones.
    assert.match(markup(), /"value":5/);
    assert.match(markup(), /"value":100/);
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("only the field that was changed is written, so the rest keep inheriting", async () => {
  const { calls, client } = stubClient();
  const { view } = await mount(client, "s1");
  try {
    // Change one number, leave everything else as the card opened.
    const depth = (view.root as unknown as { findAllByType: (type: string) => { props: { "aria-label"?: string; onChange?: (event: { target: { value: string } }) => void } }[] })
      .findAllByType("input")
      .find((node) => node.props["aria-label"] === "最大深度");
    assert.ok(depth, "the depth field is drawn");
    await act(async () => { depth!.props.onChange?.({ target: { value: "3" } }); });
    await act(async () => { click(view, "确认"); });
    await flush();

    assert.equal(calls.filter((call) => call.method === "PUT").length, 0, "no global write");
    const patch = calls.find((call) => call.method === "PATCH");
    assert.ok(patch, "the session is patched");
    assert.equal(patch!.path, "/api/sessions/s1");
    // Only what differs travels: pinning all five would freeze the other four at
    // today's global values and a later global edit would never reach them.
    assert.deepEqual((patch!.body as { ideaTreeOverride: object }).ideaTreeOverride, { maxDepth: 3 });
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("the card offers exactly 确认, 取消 and 覆盖全局设置", async () => {
  const { client } = stubClient();
  const { markup, view } = await mount(client, "s1");
  try {
    const labels = view.root.findAllByType("button").map((node) => String(node.props.children));
    // 跟随全局设置 is gone on purpose: an override is released by putting every
    // field back to the deployment value and confirming, which the empty-diff
    // path writes as `{}`.
    assert.deepEqual(labels.filter((label) => label !== "×"), ["确认", "取消", "覆盖全局设置"]);
    assert.doesNotMatch(markup(), /跟随全局设置/);
    // The top hint says what each of the two writes means for the defaults.
    assert.match(markup(), /单次修改只用于当前会话，不影响全局默认/);
    assert.match(markup(), /只有点「覆盖全局设置」才会改全局默认/);
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("overwriting the global settings writes the edit and touches no Session", async () => {
  const { calls, client } = stubClient();
  const { view } = await mount(client, "s1");
  try {
    const nodes = (view.root as unknown as { findAllByType: (type: string) => { props: { "aria-label"?: string; onChange?: (event: { target: { value: string } }) => void } }[] })
      .findAllByType("input")
      .find((node) => node.props["aria-label"] === "最大节点数");
    await act(async () => { nodes!.props.onChange?.({ target: { value: "120" } }); });
    await act(async () => { click(view, "覆盖全局设置"); });
    await flush();
    assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "no session write");
    const put = calls.find((call) => call.method === "PUT");
    assert.ok(put, "the global settings are written");
    assert.equal(put!.path, "/api/settings/idea-tree");
    const body = put!.body as Record<string, unknown>;
    assert.equal(body.maxNodes, 120);
    // The per-call cap left with #1281 and must not come back through this card.
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
    // One control needs a Session: the override write, and with it the research
    // the card would start. Cancel and the global write stay pressable.
    assert.equal((markup().match(/"disabled":true/g) ?? []).length, 1,
      "exactly the Session-scoped action is refused");
    assert.match(markup(), /只用于本次会话|确认/);
    assert.match(markup(), /覆盖全局设置/);
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("the number fields keep the last good value instead of holding one the write path rejects", async () => {
  const { client } = stubClient();
  const { view } = await mount(client, "s1");
  try {
    const depth = (view.root as unknown as { findAllByType: (type: string) => { props: { "aria-label"?: string; onChange?: (event: { target: { value: string } }) => void; value?: number } }[] })
      .findAllByType("input")
      .find((node) => node.props["aria-label"] === "最大深度");
    assert.ok(depth, "the depth field is drawn");
    // Empty, zero, a fraction and an out-of-range value all leave 5 in place:
    // both write paths want an integer in range, and a form that can hold 0 or
    // 3.5 is a form whose save button fails.
    for (const raw of ["", "0", "3.5", "21"]) {
      await act(async () => { depth!.props.onChange?.({ target: { value: raw } }); });
    }
    assert.equal(depth!.props.value, 5, "the field still shows the last accepted value");
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("confirming writes the change and then lets the command out", async () => {
  const { calls, client } = stubClient();
  const confirmed: number[] = [];
  let view: { toJSON: () => unknown; root: never; unmount: () => void };
  await act(async () => {
    view = create(
      <IdeaTreeOverrideDialog
        client={client as never}
        onClose={() => {}}
        onConfirm={() => { confirmed.push(1); }}
        sessionId="s1"
      />,
    ) as never;
  });
  await flush();
  try {
    const depth = (view.root as unknown as { findAllByType: (type: string) => { props: { "aria-label"?: string; onChange?: (event: { target: { value: string } }) => void } }[] })
      .findAllByType("input")
      .find((node) => node.props["aria-label"] === "最大深度");
    await act(async () => { depth!.props.onChange?.({ target: { value: "3" } }); });
    await act(async () => { click(view as never, "确认"); });
    await flush();
    // The parameters go to the Session first, then the command is allowed out.
    const patch = calls.find((call) => call.method === "PATCH");
    assert.equal(patch?.path, "/api/sessions/s1");
    assert.equal(confirmed.length, 1, "the shell was told to send");
    assert.equal(calls.filter((call) => call.method === "PUT").length, 0, "global untouched");
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("confirming with nothing changed still lets the command out", async () => {
  const { calls, client } = stubClient();
  const confirmed: number[] = [];
  let view: { toJSON: () => unknown; root: never; unmount: () => void };
  await act(async () => {
    view = create(
      <IdeaTreeOverrideDialog
        client={client as never}
        onClose={() => {}}
        onConfirm={() => { confirmed.push(1); }}
        sessionId="s1"
      />,
    ) as never;
  });
  await flush();
  try {
    await act(async () => { click(view as never, "确认"); });
    await flush();
    // No field differs, so there is nothing to store — but the command that is
    // waiting on this card must still leave, or confirming would swallow it.
    assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "no write needed");
    assert.equal(confirmed.length, 1, "the command was let out anyway");
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("the card opens on what the Session pinned, not on the deployment values", async () => {
  SESSION_OVERRIDES = { maxDepth: 3 };
  const { client } = stubClient();
  const { markup, view } = await mount(client, "s1");
  try {
    // 3 is what this Session runs with; the global value is 5. Showing 5 would
    // mean the reader cannot tell what is actually in force, and a second save
    // would re-pin the old number.
    assert.match(markup(), /"value":3/);
    // The deployment values are still the baseline the other fields follow.
    assert.match(markup(), /"value":100/);
    assert.match(markup(), /本次会话已固定部分参数/);
  } finally {
    SESSION_OVERRIDES = {};
    await act(async () => { view.unmount(); });
  }
});

test("putting every field back to the deployment value releases the pin", async () => {
  // The natural undo: the Session pins maxDepth 3, the deployment says 5, and the
  // reader types 5 back. Before this, the card reported 已用于本次会话 and sent
  // nothing, so the Session kept running 3.
  SESSION_OVERRIDES = { maxDepth: 3 };
  const { calls, client } = stubClient();
  const { view } = await mount(client, "s1");
  try {
    const depth = (view.root as unknown as { findAllByType: (type: string) => { props: { "aria-label"?: string; onChange?: (event: { target: { value: string } }) => void } }[] })
      .findAllByType("input")
      .find((node) => node.props["aria-label"] === "最大深度");
    await act(async () => { depth!.props.onChange?.({ target: { value: "5" } }); });
    await act(async () => { click(view, "确认"); });
    await flush();
    const patch = calls.find((call) => call.method === "PATCH");
    assert.ok(patch, "the undo has to be written, or the pin stays");
    assert.deepEqual((patch!.body as { ideaTreeOverride: unknown }).ideaTreeOverride, {});
  } finally {
    SESSION_OVERRIDES = {};
    await act(async () => { view.unmount(); });
  }
});

test("a global write rebases the diff, so nothing is pinned at the value it inherits", async () => {
  const { calls, client } = stubClient();
  const { view } = await mount(client, "s1");
  try {
    const nodes = (view.root as unknown as { findAllByType: (type: string) => { props: { "aria-label"?: string; onChange?: (event: { target: { value: string } }) => void } }[] })
      .findAllByType("input")
      .find((node) => node.props["aria-label"] === "最大节点数");
    await act(async () => { nodes!.props.onChange?.({ target: { value: "120" } }); });
    await act(async () => { click(view, "覆盖全局设置"); });
    await flush();
    // The deployment now says 120, so a later Session save has nothing to pin.
    await act(async () => { click(view, "确认"); });
    await flush();
    const patches = calls.filter((call) => call.method === "PATCH");
    // 120 equals the value it now inherits, so the diff is empty and nothing is pinned.
    assert.deepEqual(
      patches.map((call) => (call.body as { ideaTreeOverride: unknown }).ideaTreeOverride),
      [],
    );
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("opening a pinned Session and overwriting the global settings writes nothing", async () => {
  // Deployment 5, this Session pinned at 3. The card opens on 3 because that is
  // what the Session runs with; pressing 覆盖全局设置 without editing must not
  // carry that pin into the deployment.
  SESSION_OVERRIDES = { maxDepth: 3 };
  const { calls, client } = stubClient();
  const { markup, view } = await mount(client, "s1");
  try {
    assert.match(markup(), /"value":3/, "the card opens on the pinned value");
    await act(async () => { click(view, "覆盖全局设置"); });
    await flush();
    assert.equal(calls.filter((call) => call.method === "PUT").length, 0,
      "an untouched card writes nothing to the deployment");
    assert.match(markup(), /没有需要写入全局的改动/);
  } finally {
    SESSION_OVERRIDES = {};
    await act(async () => { view.unmount(); });
  }
});

test("an edited field is the only one the global write carries", async () => {
  SESSION_OVERRIDES = { maxDepth: 3 };
  const { calls, client } = stubClient();
  const { view } = await mount(client, "s1");
  try {
    const nodes = (view.root as unknown as { findAllByType: (type: string) => { props: { "aria-label"?: string; onChange?: (event: { target: { value: string } }) => void } }[] })
      .findAllByType("input")
      .find((node) => node.props["aria-label"] === "最大节点数");
    await act(async () => { nodes!.props.onChange?.({ target: { value: "120" } }); });
    await act(async () => { click(view, "覆盖全局设置"); });
    await flush();
    const put = calls.find((call) => call.method === "PUT");
    assert.ok(put, "the edit is written");
    // Only the field that was edited: the Session's maxDepth pin stays a pin.
    assert.deepEqual(put!.body, { maxNodes: 120 });
  } finally {
    SESSION_OVERRIDES = {};
    await act(async () => { view.unmount(); });
  }
});

test("a global write keeps the Session's pins on screen, and the new deployment as the baseline", async () => {
  // Deployment 5 / 100, Session pins maxDepth 3. The reader edits maxNodes and
  // writes it globally: the deployment moves to 120, the pin stays 3, and the
  // form must show both — showing the deployment alone would claim the
  // conversation had moved to 5 while it still runs 3.
  let deploymentMaxNodes = 100;
  SESSION_OVERRIDES = { maxDepth: 3 };
  const calls: { method: string; path: string; body: unknown }[] = [];
  const client = {
    request: async (path: string, init?: { body?: string; method?: string }) => {
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ method, path, body });
      if (method === "PUT") {
        const written = body as Record<string, unknown>;
        if (typeof written.maxNodes === "number") deploymentMaxNodes = written.maxNodes;
        return { ...GLOBAL, maxNodes: deploymentMaxNodes };
      }
      if (path.endsWith("/settings")) {
        return { overrides: { ideaTreeOverride: SESSION_OVERRIDES }, sources: {}, effective: {} };
      }
      return GLOBAL;
    },
  } as never;

  const { markup, view } = await mount(client, "s1");
  try {
    const nodes = (view.root as unknown as { findAllByType: (type: string) => { props: { "aria-label"?: string; onChange?: (event: { target: { value: string } }) => void } }[] })
      .findAllByType("input")
      .find((node) => node.props["aria-label"] === "最大节点数");
    await act(async () => { nodes!.props.onChange?.({ target: { value: "120" } }); });
    await act(async () => { click(view, "覆盖全局设置"); });
    await flush();

    // The deployment moved, and the pin is still what this Session runs with.
    assert.match(markup(), /"value":120/, "the new deployment value is shown");
    assert.match(markup(), /"value":3/, "the pin is still shown");
    assert.match(markup(), /本次会话已固定部分参数/);
  } finally {
    SESSION_OVERRIDES = {};
    await act(async () => { view.unmount(); });
  }
});

test("each row shows the deployment value it inherits, and marks what it overrides", async () => {
  SESSION_OVERRIDES = { maxDepth: 3 };
  const { client } = stubClient();
  const { markup, view } = await mount(client, "s1");
  try {
    // 跟随全局设置 is gone, so the undo has to be visible: the deployment value
    // sits beside every field, and the pinned one is marked as overridden.
    assert.match(markup(), /全局：5/, "the inherited depth is shown");
    assert.match(markup(), /全局：100/, "the inherited node cap is shown");
    assert.match(markup(), /已覆盖/, "the pinned field is marked");
  } finally {
    SESSION_OVERRIDES = {};
    await act(async () => { view.unmount(); });
  }
});

test("seeding the command needs a conversation and a read, so 确认 is refused without one", async () => {
  // The settings row supplies onConfirm, so the old "no command waiting" rule
  // would let this press through: it writes nothing (no Session) and would place
  // a token that runs on the deployment values while the hint promises "these
  // values".
  const { calls, client } = stubClient();
  const confirmed: number[] = [];
  const { markup, view } = await mountTo(client, undefined, () => { confirmed.push(1); }, true);
  try {
    assert.match(markup(), /打开一个会话后/);
    const confirm = view.root.findAllByType("button").find((node) => String(node.props.children) === "确认");
    assert.ok(confirm, "the confirm action is drawn");
    assert.equal(confirm.props.disabled, true, "it must not be pressable without a conversation");
    await act(async () => { confirm.props.onClick?.(); });
    await flush();
    assert.equal(confirmed.length, 0, "nothing was started");
    assert.equal(calls.filter((call) => call.method !== "GET").length, 0, "and nothing was written");
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("seeding the command is refused when the settings could not be read", async () => {
  // Same guarantee from the other direction: with no draft there is nothing to
  // write, so a token placed here would run on whatever is in force while the
  // reader believes they just set it.
  const { client } = failingClient();
  const confirmed: number[] = [];
  const { view } = await mountTo(client, "s1", () => { confirmed.push(1); }, true);
  try {
    assert.match(JSON.stringify(view.toJSON()), /settings unavailable/);
    const confirm = view.root.findAllByType("button").find((node) => String(node.props.children) === "确认");
    assert.ok(confirm, "the confirm action is drawn");
    assert.equal(confirm.props.disabled, true, "a failed read cannot place the token");
    await act(async () => { confirm.props.onClick?.(); });
    await flush();
    assert.equal(confirmed.length, 0);
  } finally {
    await act(async () => { view.unmount(); });
  }
});

/** Mount with the settings-row shape: an onConfirm, and seedsCommand set. */
async function mountTo(client: unknown, sessionId: string | undefined, onConfirm: () => void, seedsCommand: boolean) {
  const mounted: Array<ReturnType<typeof create>> = [];
  await act(async () => {
    mounted.push(create(
      <IdeaTreeOverrideDialog
        client={client as never}
        onClose={() => {}}
        onConfirm={onConfirm}
        sessionId={sessionId}
        seedsCommand={seedsCommand}
      />,
    ));
  });
  await flush();
  const view = mounted[0];
  assert.ok(view, "the dialog mounted");
  return { markup: () => JSON.stringify(view.toJSON()), view };
}

/** A client whose Idea Tree settings read fails, for the states below. */
function failingClient() {
  const calls: { method: string; path: string }[] = [];
  return {
    calls,
    client: {
      request: async (path: string, init?: { method?: string }) => {
        const method = init?.method ?? "GET";
        calls.push({ method, path });
        if (method === "GET" && !path.endsWith("/settings")) throw new Error("settings unavailable");
        return { overrides: {}, sources: {}, effective: {} };
      },
    } as never,
  };
}

test("a failed settings read disables the Session action instead of leaving it inert", async () => {
  const { client } = failingClient();
  // The 会话设置 entry: no command waiting, so there is nothing to send.
  const { markup, view } = await mount(client, "s1");
  try {
    assert.match(markup(), /settings unavailable/);
    const save = (view.root as unknown as { findAllByType: (type: string) => { props: { children?: unknown; disabled?: boolean; onClick?: () => void } }[] })
      .findAllByType("button")
      .find((node) => String(node.props.children) === "确认");
    assert.ok(save, "the save action is drawn");
    assert.equal(save!.props.disabled, true, "nothing to save, so it must not be pressable");
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("a failed settings read still lets a waiting command out", async () => {
  const { client } = failingClient();
  const confirmed: number[] = [];
  let view: { toJSON: () => unknown; root: never; unmount: () => void };
  await act(async () => {
    view = create(
      <IdeaTreeOverrideDialog
        client={client as never}
        onClose={() => {}}
        onConfirm={() => { confirmed.push(1); }}
        sessionId="s1"
      />,
    ) as never;
  });
  await flush();
  try {
    const save = (view.root as unknown as { findAllByType: (type: string) => { props: { children?: unknown; disabled?: boolean; onClick?: () => void } }[] })
      .findAllByType("button")
      .find((node) => String(node.props.children) === "确认");
    assert.ok(save, "the confirm action is drawn");
    assert.equal(save!.props.disabled, false, "the command has to be releasable");
    await act(async () => { save!.props.onClick?.(); });
    await flush();
    assert.equal(confirmed.length, 1, "the command was let out without a write");
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("a failed write keeps the Session action pressable, so the reader can retry", async () => {
  // The read succeeded, so the draft is there; the PATCH fails. Disabling the
  // button here would strand the card until an unrelated edit reset the status.
  let attempts = 0;
  const calls: { method: string; path: string; body: unknown }[] = [];
  const client = {
    request: async (path: string, init?: { body?: string; method?: string }) => {
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ method, path, body });
      if (path.endsWith("/settings")) return { overrides: {}, sources: {}, effective: {} };
      if (method === "PATCH") {
        attempts += 1;
        if (attempts === 1) throw new Error("Session write refused");
        return {} as never;
      }
      return GLOBAL;
    },
  } as never;

  const { view } = await mount(client, "s1");
  try {
    const depth = (view.root as unknown as { findAllByType: (type: string) => { props: { "aria-label"?: string; onChange?: (event: { target: { value: string } }) => void } }[] })
      .findAllByType("input")
      .find((node) => node.props["aria-label"] === "最大深度");
    await act(async () => { depth!.props.onChange?.({ target: { value: "3" } }); });

    const save = () => (view.root as unknown as { findAllByType: (type: string) => { props: { children?: unknown; disabled?: boolean; onClick?: () => void } }[] })
      .findAllByType("button")
      .find((node) => String(node.props.children) === "确认");

    await act(async () => { save()!.props.onClick?.(); });
    await flush();
    assert.equal(attempts, 1, "the write was attempted");
    assert.equal(save()!.props.disabled, false, "the retry must stay pressable");

    await act(async () => { save()!.props.onClick?.(); });
    await flush();
    assert.equal(attempts, 2, "the second press retried the write");
    assert.equal(calls.filter((call) => call.method === "PATCH").length, 2);
  } finally {
    await act(async () => { view.unmount(); });
  }
});
