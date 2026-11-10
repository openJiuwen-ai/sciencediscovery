// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectorConfigurationRequest } from "@sciencediscovery/schema";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";
import { legacyConfigurationPresentation } from "../src/app/legacy-configuration.js";
import { decideLegacyConnectorConfiguration } from "../src/api/configuration.js";
import { ConfigurationRecord, Conversation } from "../src/views/Conversation.js";
import { LegacyConnectorConfigurationCard } from "../src/views/LegacyConnectorConfigurationCard.js";
import { emptyRunStream } from "../src/run-stream/model.js";
import { StubClient, json } from "./api-stub.js";
import { setLanguage } from "../src/text.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function request(overrides: Partial<ConnectorConfigurationRequest> = {}): ConnectorConfigurationRequest {
  return { id: "legacy", sessionId: "s", projectId: "p", runId: "user-request:standalone", connectorId: "pubmed", connectorName: "PubMed 文献检索",
    reason: "USER_REQUESTED_CONNECTOR", baselineConnectorIds: [], state: "awaiting_confirmation", createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z", ...overrides };
}
function button(tree: ReactTestRenderer, label: string) {
  const found = tree.root.findAllByType("button").find(node => node.children.join("") === label);
  assert.ok(found, label); return found;
}
async function mount(options: { readOnly?: boolean; runActive?: boolean; request?: ConnectorConfigurationRequest;
  decide?: (decision: "apply" | "dismiss") => Promise<void>; refresh?: () => Promise<void> } = {}) {
  setLanguage("en"); let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<LegacyConnectorConfigurationCard request={options.request ?? request()}
    readOnly={options.readOnly ?? false} runActive={options.runActive ?? false} ProcessRecord={ConfigurationRecord}
    onDecision={options.decide ?? (async () => {})} onRefresh={options.refresh ?? (async () => {})} />); });
  return tree;
}
test("legacy decisions use only the old apply/dismiss payload and encoded same-session path", async () => {
  const client = new StubClient().reply(request());
  for (const decision of ["apply", "dismiss"] as const) await decideLegacyConnectorConfiguration(client.asClient(), request({ id: "r/one", sessionId: "s/one" }), decision);
  assert.deepEqual(client.calls.map(call => call.path), Array(2).fill("/api/sessions/s%2Fone/configuration-requests/r%2Fone/decision"));
  assert.deepEqual(client.calls.map(json), [{ decision: "apply" }, { decision: "dismiss" }]);
  assert.ok(client.calls.every(call => call.init.method === "POST"));
});
test("legacy confirmation suppresses repeated clicks and neither mount nor countdown applies automatically", async () => {
  let done!: () => void; const calls: string[] = [];
  const tree = await mount({ request: request({ autoApplyAt: "2000-01-01T00:00:00Z" }), decide: decision => { calls.push(decision); return new Promise(resolve => { done = resolve; }); } });
  assert.match(JSON.stringify(tree.toJSON()), /Waiting for the server/); assert.deepEqual(calls, []);
  const confirm = button(tree, "Confirm and enable");
  await act(async () => { (confirm.props.onClick as () => void)(); (confirm.props.onClick as () => void)(); });
  assert.deepEqual(calls, ["apply"]); assert.equal(button(tree, "Not now").props.disabled, true);
  await act(async () => done()); await act(async () => tree.unmount());
});
test("legacy read-only and active-run guards reject actions even when an old callback is invoked", async () => {
  for (const guard of [{ readOnly: true }, { runActive: true }]) {
    let calls = 0; const tree = await mount({ ...guard, decide: async () => { calls++; } });
    for (const label of ["Confirm and enable", "Not now"]) {
      const action = button(tree, label); assert.equal(action.props.disabled, true);
      await act(async () => (action.props.onClick as () => void)());
    }
    assert.equal(calls, 0); await act(async () => tree.unmount());
  }
});
test("an uncertain legacy decision is redacted and cannot repeat before a successful status refresh", async () => {
  let calls = 0; let refreshes = 0;
  const tree = await mount({ decide: async () => { calls++; throw new Error("private-backend-credential"); },
    refresh: async () => { refreshes++; if (refreshes === 1) throw new Error("network"); } });
  await act(async () => (button(tree, "Not now").props.onClick as () => void)());
  assert.equal(calls, 1); assert.match(JSON.stringify(tree.toJSON()), /Refresh its status/);
  assert.doesNotMatch(JSON.stringify(tree.toJSON()), /private-backend-credential/);
  assert.equal(button(tree, "Confirm and enable").props.disabled, true);
  await act(async () => (button(tree, "Refresh status").props.onClick as () => void)());
  assert.equal(button(tree, "Confirm and enable").props.disabled, true);
  await act(async () => (button(tree, "Refresh status").props.onClick as () => void)());
  assert.equal(button(tree, "Confirm and enable").props.disabled, false);
  assert.equal(calls, 1); await act(async () => tree.unmount());
});
test("legacy terminal records are read-only native receipts in both languages", () => {
  for (const language of ["en", "zh-CN"] as const) {
    setLanguage(language);
    for (const state of ["applied", "dismissed", "stale"] as const) {
      const html = renderToStaticMarkup(<LegacyConnectorConfigurationCard request={request({ state })} readOnly={false} runActive={false}
        onDecision={async () => { throw Error("unexpected"); }} onRefresh={async () => {}} ProcessRecord={ConfigurationRecord} />);
      assert.match(html, /msg-collapse tool-card desktop-configuration-record/); assert.doesNotMatch(html, /<button/);
      assert.match(html, language === "en" ? /Saved|Not configured|Request out of date/ : /已保存|未配置|请求已过时/);
    }
  }
  setLanguage("en");
});
test("legacy receipts recognize old checkpoint/run anchors and suppress duplicates without swallowing other notices", () => {
  const saved = request({ state: "applied", continuationRunId: "continued" });
  const notices = [
    { id: "configuration:legacy", kind: "configuration_notice", content: "" },
    { id: "old-run-notice", kind: "configuration_notice", content: "" },
    { id: "another", kind: "configuration_notice", content: "Keep this" },
  ] as never;
  const view = legacyConfigurationPresentation([saved], notices, [{ runId: "continued", userMessageId: "old-run-notice", state: emptyRunStream() }], "s");
  assert.equal(view.byNoticeId.get("configuration:legacy"), saved); assert.deepEqual([...view.suppressedNoticeIds], ["old-run-notice"]);
  assert.equal(view.visibleRequests.length, 0);
  assert.equal(legacyConfigurationPresentation([saved], notices, [], "other").byNoticeId.size, 0);
});
test("desktop renders legacy-only sessions and gates fetch failures, archived records and unrelated runs", () => {
  setLanguage("en");
  for (const [readOnly, error, run] of [[false, false, emptyRunStream()], [true, false, emptyRunStream()], [false, true, emptyRunStream()],
    [false, false, { ...emptyRunStream(), runId: "other-run" }]] as const) {
    const html = renderToStaticMarkup(<Conversation client={new StubClient().asClient()} loading={false} detail={{ id: "s", messages: [] } as never}
      configuration={{ requests: [], legacyRequests: [request()], loading: false, error, refresh: async () => {}, update: () => {}, remove: () => {} }}
      configurationReadOnly={readOnly} onDecidePermission={async () => {}} replays={[]} run={run} workspaceFiles={[]} />);
    assert.match(html, /id="configuration-request-legacy"/); assert.match(html, /PubMed 文献检索/);
    assert.equal(/<button[^>]*disabled=""[^>]*>Confirm and enable/.test(html), readOnly || error || Boolean(run.runId));
  }
});
