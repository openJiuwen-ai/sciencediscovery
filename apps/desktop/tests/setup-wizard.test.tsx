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
import { TEXT } from "../src/text.js";
import { SetupWizard } from "../src/views/SetupWizard.js";

const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

// Static rendering runs no effect and no handler, so nothing in the wizard
// reaches the service; the steps only need the prop to satisfy the type.
const client = {} as unknown as ApiClient;
const noop = () => undefined;

/**
 * The wizard walks three steps in the shell's order. Each step is rendered on
 * its own through `initialStep`, because there is no DOM here to click forward
 * with — the transitions themselves are exercised in the browser E2E journeys.
 */
describe("the first-run setup wizard", () => {
  it("opens on the workspace directory, which is recorded rather than applied", () => {
    const markup = renderToStaticMarkup(
      <SetupWizard
        client={client}
        onConfigured={noop}
        onProvidersChanged={noop}
        presets={[]}
        providers={[]}
      />,
    );

    assert.ok(markup.includes(TEXT.wizard.workspace.title));
    assert.ok(markup.includes(TEXT.wizard.workspace.sub));
    assert.ok(markup.includes(TEXT.wizard.workspace.label));
    assert.ok(markup.includes(TEXT.wizard.workspace.note));
    assert.ok(markup.includes(TEXT.wizard.workspace.skip));
    assert.ok(markup.includes(TEXT.wizard.workspace.next));
    // The right panel is the same on every step.
    assert.ok(markup.includes(TEXT.wizard.art.title));
    assert.ok(markup.includes('data-step="workspace"'));
    // The provider form belongs to the next step, not this one.
    assert.ok(!markup.includes(TEXT.wizard.testAndContinue));
  });

  it("keeps the shell's environment check as its own step", () => {
    const markup = renderToStaticMarkup(
      <SetupWizard
        client={client}
        initialStep="boot"
        onConfigured={noop}
        onProvidersChanged={noop}
        presets={[]}
        providers={[]}
      />,
    );

    assert.ok(markup.includes(TEXT.wizard.boot.title));
    assert.ok(markup.includes(TEXT.wizard.boot.starting));
    assert.ok(markup.includes(TEXT.wizard.boot.hint));
    assert.ok(markup.includes('data-step="boot"'));
    // 返回上一步 is the only way back, and the form belongs to the step after
    // this one.
    assert.ok(markup.includes(TEXT.wizard.back));
    assert.ok(!markup.includes(TEXT.wizard.testAndContinue));
  });

  it("is a model step whose final action waits for a successful test", () => {
    const markup = renderToStaticMarkup(
      <SetupWizard
        client={client}
        initialStep="model"
        onConfigured={noop}
        onProvidersChanged={noop}
        presets={[]}
        providers={[]}
      />,
    );

    assert.ok(markup.includes(TEXT.wizard.title));
    assert.ok(markup.includes(TEXT.wizard.sub));
    assert.ok(markup.includes(TEXT.wizard.art.title));
    assert.ok(markup.includes(TEXT.wizard.testAndContinue));
    assert.ok(markup.includes('data-step="model"'));
    assert.ok(markup.includes(TEXT.wizard.back));
    // 返回上一步 belongs to the action row, after the continue button — not on
    // a line of its own below the form.
    const actions = markup.slice(markup.indexOf('class="form-actions"'));
    assert.ok(actions.indexOf(TEXT.wizard.testAndContinue) < actions.indexOf(TEXT.wizard.back));
    assert.ok(actions.indexOf(TEXT.wizard.back) < actions.indexOf("</div>"));
    // 开始使用 is the continuation, not a second save: it must stay hidden until
    // the connectivity test in this form passes.
    assert.ok(!markup.includes(`>${TEXT.wizard.finish}</button>`));
  });
});
