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
  testModel: (modelId: string) => Promise<ModelConnectivityTestResult>,
  profileVersion = "version-1",
  disabled = false,
) {
  return createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ModelConnectivityButton, {
    disabled,
    modelId: "model-1",
    modelName: "DeepSeek V4",
    profileVersion,
    testModel,
  }));
}

function buttonText(renderer: ReactTestRenderer): string {
  return renderer.root.findByType("button").findByType("span").children.join("");
}

test("model test button spins, shows a result, and can be clicked again", async () => {
  let resolveFirst: ((value: ModelConnectivityTestResult) => void) | undefined;
  const first = new Promise<ModelConnectivityTestResult>((resolve) => { resolveFirst = resolve; });
  const responses = [first, Promise.resolve(authorizationFailure)];
  let calls = 0;
  const testModel = async (modelId: string) => {
    assert.equal(modelId, "model-1");
    calls += 1;
    return await responses.shift()!;
  };
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(view(testModel)); });
  assert.equal(buttonText(renderer!), "测试");

  await act(async () => { renderer!.root.findByType("button").props.onClick(); });
  const testingButton = renderer!.root.findByType("button");
  assert.equal(buttonText(renderer!), "测试中");
  assert.equal(testingButton.props.disabled, true);
  assert.equal(testingButton.props["aria-busy"], true);
  assert.equal(testingButton.findByType("svg").props.className, "spin");

  await act(async () => { resolveFirst?.(success); });
  assert.equal(buttonText(renderer!), "可用 · 42 ms");
  assert.equal(renderer!.root.findByType("button").props.disabled, false);

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
  await act(async () => {
    renderer!.root.findByType("button").props.onClick();
    await Promise.resolve();
  });
  assert.equal(buttonText(renderer!), "可用 · 42 ms");
  await act(async () => { renderer!.update(view(testModel, "version-2")); });
  assert.equal(buttonText(renderer!), "测试");
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
