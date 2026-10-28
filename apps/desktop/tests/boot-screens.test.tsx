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
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TEXT } from "../src/text.js";
import { AuthScreen } from "../src/views/AuthScreen.js";
import { OfflineScreen } from "../src/views/OfflineScreen.js";
import { SetupWizard } from "../src/views/SetupWizard.js";
import { StubClient } from "./api-stub.js";

const noop = () => {};
const client = new StubClient().asClient();

describe("the authentication gate", () => {
  it("asks for a token, with the submit disabled until one is typed", () => {
    const markup = renderToStaticMarkup(<AuthScreen onSubmit={noop} rejected={false} />);

    assert.ok(markup.includes(TEXT.boot.noTokenTitle));
    assert.ok(markup.includes(TEXT.boot.noTokenBody));
    assert.ok(markup.includes(TEXT.boot.tokenLabel));
    assert.ok(markup.includes(TEXT.boot.tokenPlaceholder));
    assert.ok(markup.includes(TEXT.boot.tokenSubmit));
    assert.match(markup, /disabled=""/, "an empty token can be submitted");
    // The field is the only thing to do on this page, so it takes focus.
    assert.match(markup, /autofocus=""/);
  });

  it("separates a refused token from a missing one", () => {
    const markup = renderToStaticMarkup(<AuthScreen onSubmit={noop} rejected />);

    assert.ok(markup.includes(TEXT.boot.rejectedTitle));
    assert.ok(markup.includes(TEXT.boot.rejectedBody));
    assert.ok(!markup.includes(TEXT.boot.noTokenTitle));
    assert.ok(!markup.includes(TEXT.boot.noTokenBody));
  });
});

describe("the offline screen", () => {
  it("says the service is unreachable and offers only a retry", () => {
    const markup = renderToStaticMarkup(<OfflineScreen onRetry={noop} reason="unreachable" />);

    assert.ok(markup.includes(TEXT.boot.offlineTitle));
    assert.ok(markup.includes(TEXT.boot.offlineBody));
    assert.ok(markup.includes(TEXT.boot.retry));
    // No credential hint: the service never answered, so the token is not the
    // question yet.
    assert.ok(!markup.includes(TEXT.boot.noTokenBody));
  });

  it("adds the credential hint when the service answered but refused the token", () => {
    const markup = renderToStaticMarkup(<OfflineScreen onRetry={noop} reason="auth" />);

    assert.ok(markup.includes(TEXT.boot.offlineTitle));
    assert.ok(markup.includes(TEXT.boot.noTokenBody));
  });
});

describe("the first-run setup wizard", () => {
  it("opens on the workspace step, which records a directory without moving data", () => {
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
    assert.ok(markup.includes(TEXT.wizard.workspace.placeholder));
    // The note is what stops the field being read as a data-directory setting.
    assert.ok(markup.includes(TEXT.wizard.workspace.note));
    assert.ok(markup.includes(`>${TEXT.wizard.workspace.skip}</button>`));
    assert.ok(markup.includes(`>${TEXT.wizard.workspace.next}</button>`));
    assert.ok(markup.includes(TEXT.wizard.art.title));
    // One panel, three steps: the progress bar reports where the reader is.
    assert.match(markup, /class="wizard-progress" data-step="workspace"/);
    // The wizard has no way out, so it must not draw 取消.
    assert.ok(!markup.includes(`>${TEXT.menu.cancel}</button>`));
  });

  it("makes the model step the last, and 开始使用 waits for a successful test", () => {
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
    // 开始使用 is the continuation, not a second save: it must stay hidden until
    // the connectivity test in this form passes.
    assert.ok(!markup.includes(`>${TEXT.wizard.finish}</button>`));
    assert.ok(!markup.includes(`>${TEXT.menu.cancel}</button>`));
    assert.match(markup, /class="wizard-progress" data-step="model"/);
    // The model step is the one place to go back; the workspace step has none.
    assert.ok(markup.includes(`>${TEXT.wizard.back}</button>`));
  });

  it("asks for a protocol only on the custom branch", () => {
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

    assert.ok(markup.includes(TEXT.wizard.custom.protocol));
    assert.ok(markup.includes(TEXT.wizard.custom.option));
  });
});
