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
import { ModelForm } from "../src/views/ModelForm.js";

// Any wording works for the submit label; the assertions never read it.
const SUBMIT = "save";

const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

// Static rendering runs no effect and no handler, so the form never reaches
// the service; the props only need to satisfy the types.
const client = {} as unknown as ApiClient;
const noop = () => undefined;

const count = (markup: string, needle: string) => markup.split(needle).length - 1;

/**
 * The 模型名称 field is a single combobox, not the old pairing of a
 * hand-typed input with a parallel native <select> of the fetched listing.
 * Static rendering cannot fetch a listing (no effects run), so what these
 * cases pin is the contract the replacement must keep in its idle shape:
 * one combobox input, no third <select> sneaking back in, and a clean
 * plain-input degradation while no listing exists. The keyboard/menu
 * interactions are covered by the browser E2E journeys.
 */
describe("the model-name field", () => {
  it("is a single combobox instead of a hand-typed input plus a parallel select", () => {
    const markup = renderToStaticMarkup(
      <ModelForm
        client={client}
        onConfigured={noop}
        onProvidersChanged={noop}
        presets={[]}
        providers={[]}
        submitLabel={SUBMIT}
      />,
    );

    // presets=[] takes the custom branch: preset select + protocol select.
    assert.equal(count(markup, "<select"), 2);
    assert.ok(markup.includes('role="combobox"'));
    assert.ok(markup.includes('aria-autocomplete="list"'));
    assert.ok(markup.includes('aria-expanded="false"'));
    assert.ok(markup.includes(TEXT.wizard.provider.model));
    assert.ok(markup.includes(TEXT.wizard.provider.modelPlaceholder));
    // The old parallel picker's placeholder copy must not come back.
    assert.ok(!("selectPlaceholder" in TEXT.wizard.provider));
  });

  it("keeps a preset provider on one select and still renders the combobox", () => {
    const presets = [
      {
        baseUrl: "https://api.example.com/v1",
        id: "example",
        name: "Example",
        tokenOptional: false,
      },
    ];
    const markup = renderToStaticMarkup(
      <ModelForm
        client={client}
        onConfigured={noop}
        onProvidersChanged={noop}
        presets={presets}
        providers={[]}
        submitLabel={SUBMIT}
      />,
    );

    // A preset branch has no protocol select; the model combobox is not one.
    assert.equal(count(markup, "<select"), 1);
    assert.ok(markup.includes('role="combobox"'));
  });

  it("degrades to a plain input with no fetched listing: no toggle, no menu", () => {
    const markup = renderToStaticMarkup(
      <ModelForm
        client={client}
        onConfigured={noop}
        onProvidersChanged={noop}
        presets={[]}
        providers={[]}
        submitLabel={SUBMIT}
      />,
    );

    // Without a listing the combobox must not render its toggle or an empty
    // menu — gateways without a /models endpoint get a plain input.
    assert.ok(!markup.includes("field-combo-toggle"));
    assert.ok(!markup.includes("field-combo-menu"));
  });
});
