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


import type { ModelConnectivityTestResult } from "@sciencediscovery/schema";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { LocaleProvider } from "../src/i18n/index.js";
import { ModelConnectivityButton } from "../src/ModelConnectivityButton.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const success: ModelConnectivityTestResult = {
  category: "ok",
  latencyMs: 42,
  message: "Connection succeeded",
  ok: true,
  providerStatus: 200,
  testedAt: "2026-08-26T00:00:00.000Z",
};

const authorizationFailure: ModelConnectivityTestResult = {
  category: "authorization",
  latencyMs: 18,
  message: "API key is invalid or is not authorized",
  ok: false,
  providerStatus: 401,
  testedAt: "2026-08-26T00:00:01.000Z",
};

function view(
  testModel: (modelId: string, compatibility?: boolean) => Promise<ModelConnectivityTestResult>,
  profileVersion = "version-1",
  disabled = false,
  locale: "zh-CN" | "en" = "zh-CN",
) {
  return createElement(LocaleProvider, { initialLocale: locale }, createElement(ModelConnectivityButton, {
    disabled,
    modelId: "model-1",
    modelName: "DeepSeek V4",
    profileVersion,
    testModel,
  }));
}

async function acceptProbeCost(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => { renderer.root.findByType("input").props.onChange({ target: { checked: true } }); });
}

function buttonText(renderer: ReactTestRenderer): string {
  return renderer.root.findByType("button").findByType("span").children.join("");
}

test("model test button spins, shows a result, and can be clicked again", async () => {
  let resolveFirst: ((value: ModelConnectivityTestResult) => void) | undefined;
  const first = new Promise<ModelConnectivityTestResult>((resolve) => { resolveFirst = resolve; });
  const responses = [first, Promise.resolve(authorizationFailure)];
  let calls = 0;
  const testModel = async (modelId: string, compatibility?: boolean) => {
    assert.equal(modelId, "model-1");
    assert.equal(compatibility, false);
    calls += 1;
    return await responses.shift()!;
  };
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(view(testModel)); });
  assert.equal(buttonText(renderer!), "测试");

  await acceptProbeCost(renderer!);
  await act(async () => { renderer!.root.findByType("button").props.onClick(); });
  const testingButton = renderer!.root.findByType("button");
  assert.equal(buttonText(renderer!), "测试中");
  assert.equal(testingButton.props.disabled, true);
  assert.equal(testingButton.props["aria-busy"], true);
  assert.equal(testingButton.findByType("svg").props.className, "spin");

  await act(async () => { resolveFirst?.(success); });
  assert.equal(buttonText(renderer!), "可用 · 42 ms");
  assert.equal(renderer!.root.findByType("button").props.disabled, false);

  await acceptProbeCost(renderer!);
  await act(async () => {
    renderer!.root.findByType("button").props.onClick();
    await Promise.resolve();
  });
  assert.equal(calls, 2);
  assert.equal(buttonText(renderer!), "鉴权失败");
  assert.match(renderer!.root.findByType("button").props.title, /API Key/);
  await act(async () => renderer!.unmount());
});

test("saving a changed profile clears its previous test result", async () => {
  const testModel = async () => success;
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(view(testModel)); });
  await acceptProbeCost(renderer!);
  await act(async () => {
    renderer!.root.findByType("button").props.onClick();
    await Promise.resolve();
  });
  assert.equal(buttonText(renderer!), "可用 · 42 ms");
  await act(async () => { renderer!.update(view(testModel, "version-2")); });
  assert.equal(buttonText(renderer!), "测试");
  assert.equal(renderer!.root.findByType("input").props.checked, false);
  assert.equal(renderer!.root.findByType("button").props.disabled, true);
  await act(async () => renderer!.unmount());
});

test("unsaved model changes disable the saved-profile test", async () => {
  let calls = 0;
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(view(async () => {
      calls += 1;
      return success;
    }, "version-1", true));
  });
  const button = renderer!.root.findByType("button");
  assert.equal(buttonText(renderer!), "请先保存");
  assert.equal(button.props.disabled, true);
  assert.match(button.props.title, /保存/);
  assert.equal(calls, 0);
  await act(async () => renderer!.unmount());
});

test("compatibility requests require explicit cost consent and render independent native outcomes", async () => {
  let calls = 0;
  const outcome = { ok: true, category: "ok" as const, message: "actual synthetic completion" };
  const protocols = (["openai-chat-completions", "openai-responses", "anthropic-messages"] as const).map(apiProtocol => ({ apiProtocol, basic: outcome, streaming: outcome, tools: { ...outcome, ok: false, category: "invalid_response" as const, message: "inconclusive tool result" }, usage: "unknown" as const }));
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(view(async () => { calls++; return { ...success, protocols }; })); });
  assert.equal(renderer!.root.findByType("button").props.disabled, true);
  await act(async () => { renderer!.root.findByType("button").props.onClick(); });
  assert.equal(calls, 0);
  await act(async () => { renderer!.root.findByType("select").props.onChange({ target: { value: "matrix" } }); });
  await acceptProbeCost(renderer!);
  await act(async () => { renderer!.root.findByType("button").props.onClick(); await Promise.resolve(); });
  assert.equal(calls, 1);
  const text = JSON.stringify(renderer!.toJSON());
  for (const protocol of protocols) assert.ok(text.includes(protocol.apiProtocol));
  assert.match(text, /用量.*未知/);
  assert.match(text, /无法确认/);
  assert.ok(!text.includes("inconclusive tool result"));
  await act(async () => renderer!.unmount());
});

test("profile changes invalidate in-flight compatibility results and request errors remain visible", async () => {
  let resolve: (value: ModelConnectivityTestResult) => void = () => undefined;
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(view(() => new Promise(done => { resolve = done; }))); });
  await acceptProbeCost(renderer!);
  await act(async () => { renderer!.root.findByType("button").props.onClick(); });
  await act(async () => { renderer!.update(view(async () => { throw new Error("transport failed"); }, "new-version")); });
  await act(async () => { resolve(success); });
  assert.equal(buttonText(renderer!), "测试");
  assert.equal(renderer!.root.findByType("input").props.checked, false);
  await acceptProbeCost(renderer!);
  await act(async () => { renderer!.root.findByType("button").props.onClick(); await Promise.resolve(); });
  assert.match(renderer!.root.findByType("button").props.title, /transport failed/);
  await act(async () => renderer!.unmount());
});

for (const locale of ['zh-CN', 'en'] as const) test(`capability and failure evidence is localized in ${locale}`, async () => {
  const categories = ['missing_token', 'authorization', 'not_found', 'rate_limited', 'timeout', 'network', 'provider_error', 'invalid_response', 'ok'] as const;
  for (const category of categories) {
    const outcome = { ok: category === 'ok', category, message: 'RAW_SERVER_ENGLISH_DO_NOT_RENDER' };
    const protocols = [{ apiProtocol: 'anthropic-messages' as const, basic: outcome, streaming: outcome, tools: outcome, usage: category === 'ok' ? 'available' as const : 'unknown' as const }];
    let renderer: ReactTestRenderer;
    await act(async () => { renderer = create(view(async () => ({ ...success, protocols }), 'v1', false, locale)); });
    await acceptProbeCost(renderer!);
    await act(async () => { renderer!.root.findByType('button').props.onClick(); await Promise.resolve(); });
    const rendered = JSON.stringify(renderer!.toJSON());
    assert.ok(!rendered.includes('RAW_SERVER_ENGLISH_DO_NOT_RENDER'));
    for (const label of locale === 'zh-CN' ? ['基本响应', '流式响应', '工具往返', '用量'] : ['Basic response', 'Streaming', 'Tool round-trip', 'Usage']) assert.ok(rendered.includes(label));
    if (category === 'ok') assert.ok(rendered.includes(locale === 'zh-CN' ? '可获取' : 'Available'));
    if (category === 'invalid_response') assert.ok(rendered.includes(locale === 'zh-CN' ? '无法确认' : 'Inconclusive'));
    await act(async () => renderer!.unmount());
  }
});

test('scope defaults to one selected-protocol request and switching to matrix requires fresh cost consent without probing', async () => {
  const modes: boolean[] = []; let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(view(async (_id, compatibility) => { modes.push(Boolean(compatibility)); return success; }, 'v1', false, 'en')); });
  assert.equal(renderer!.root.findByType('select').props.value, 'selected');
  await acceptProbeCost(renderer!); await act(async () => { await renderer!.root.findByType('button').props.onClick(); });
  assert.deepEqual(modes, [false]);
  await act(async () => { renderer!.root.findByType('select').props.onChange({ target: { value: 'matrix' } }); });
  assert.equal(renderer!.root.findByType('input').props.checked, false); assert.equal(renderer!.root.findByType('button').props.disabled, true); assert.deepEqual(modes, [false]);
  await acceptProbeCost(renderer!); await act(async () => { await renderer!.root.findByType('button').props.onClick(); });
  assert.deepEqual(modes, [false, true]); await act(async () => renderer!.unmount());
});

test('selected-protocol insufficient evidence stays inconclusive, with a specific valid-budget notice', async () => {
  for (const locale of ['en', 'zh-CN'] as const) for (const budget of [false, true]) {
    let renderer: ReactTestRenderer;
    await act(async () => { renderer = create(view(async () => ({ ...success, category: 'invalid_response', ok: false, ...(budget ? { inconclusiveReason: 'output_limit' as const } : {}) }), 'v1', false, locale)); });
    await acceptProbeCost(renderer!); await act(async () => { renderer!.root.findByType('button').props.onClick(); await Promise.resolve(); });
    assert.match(buttonText(renderer!), locale === 'en' ? /Inconclusive/ : /无法确认/);
    if (budget) assert.match(renderer!.root.findByType('button').props.title, locale === 'en' ? /output limit/ : /输出预算/);
    await act(async () => renderer!.unmount());
  }
});
