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

// The three desktop Enter sites that submit data: the SSH key browser's
// location field, the timeout number field (Enter blurs, blur commits), and
// the model-name combobox (Enter picks the highlighted listing entry). Each
// case mounts the real component and presses the key its handler reads, so it
// fails on the composition Enter today and passes once the shared rule is
// wired in.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import React from "react";

import { ModelForm } from "../src/views/ModelForm.js";
import { SshKeyFileField } from "../src/views/settings/RunnerResources.js";
import { TimeoutSettings } from "../src/views/settings/system/Timeouts.js";
import { TEXT } from "../src/text.js";
import { StubClient } from "./api-stub.js";
import { act, create } from "./support/dom-renderer.js";

const listing = { directory: "~/.ssh", parentDirectory: null, entries: [], nextOffset: null };

/** The fields these handlers read, plus the two effects they have on the event:
 *  `preventDefault` and `currentTarget.blur` (which is what commits a field). */
function enter(fields: Record<string, unknown> = {}) {
  const seen = { blurred: false, prevented: false };
  return {
    event: {
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => { seen.prevented = true; },
      stopPropagation: () => {},
      currentTarget: { blur: () => { seen.blurred = true; } },
      ...fields,
    },
    seen,
  };
}

describe("desktop SSH key browser", () => {
  it("does not ask for another listing for the Enter that accepts a candidate", async () => {
    const client = new StubClient().reply(listing).asClient();
    let view;
    await act(async () => {
      view = create(
        <SshKeyFileField
          client={client}
          label="Private key"
          onChange={() => {}}
          placeholder="~/.ssh"
          value="~/.ssh"
        />,
      );
    });
    try {
      await act(async () => { view.root.findAllByType("button")[0]!.props.onClick(); });
      const opened = (client as unknown as StubClient).calls.length;
      const location = view.root.findAllByType("input")[1]!;
      const { event } = enter({ isComposing: true, nativeEvent: { isComposing: true }, keyCode: 13 });
      await act(async () => { location.props.onKeyDown(event); });
      // Red today: the second request means the dialog re-listed ~/.ssh while
      // the user was still choosing the candidate for the path field.
      assert.equal((client as unknown as StubClient).calls.length, opened);
    } finally {
      await act(async () => { view.unmount(); });
    }
  });

  it("browses on an Enter after the candidate has been accepted", async () => {
    const client = new StubClient().reply(listing).reply(listing).asClient();
    let view;
    await act(async () => {
      view = create(
        <SshKeyFileField
          client={client}
          label="Private key"
          onChange={() => {}}
          placeholder="~/.ssh"
          value="~/.ssh"
        />,
      );
    });
    try {
      await act(async () => { view.root.findAllByType("button")[0]!.props.onClick(); });
      const opened = (client as unknown as StubClient).calls.length;
      const location = view.root.findAllByType("input")[1]!;
      const { event } = enter({ isComposing: false, nativeEvent: { isComposing: false } });
      await act(async () => { location.props.onKeyDown(event); });
      assert.equal((client as unknown as StubClient).calls.length, opened + 1);
    } finally {
      await act(async () => { view.unmount(); });
    }
  });
});

describe("timeout field", () => {
  const settings = {
    gatewayIdleTimeoutMs: 240_000,
    gatewayTurnTimeoutMs: 60_000,
    kernelIdleTimeoutMs: 60_000,
    permissionWaitTimeoutMs: 60_000,
    runnerExecTimeoutMs: 60_000,
  };

  async function mount() {
    const client = new StubClient().reply(settings).asClient();
    let view;
    await act(async () => { view = create(<TimeoutSettings client={client} />); });
    return { client, view };
  }

  it("does not blur (and therefore does not commit) for the Enter that accepts a candidate", async () => {
    const { view } = await mount();
    try {
      const input = view.root.findAllByType("input")[0]!;
      const { event, seen } = enter({ isComposing: true, nativeEvent: { isComposing: true } });
      await act(async () => { input.props.onKeyDown(event); });
      assert.equal(seen.blurred, false);
    } finally {
      await act(async () => { view.unmount(); });
    }
  });

  it("blurs on an Enter after the candidate has been accepted", async () => {
    const { view } = await mount();
    try {
      const input = view.root.findAllByType("input")[0]!;
      const { event, seen } = enter({ isComposing: false, nativeEvent: { isComposing: false } });
      await act(async () => { input.props.onKeyDown(event); });
      assert.equal(seen.blurred, true);
    } finally {
      await act(async () => { view.unmount(); });
    }
  });
});

describe("model-name combobox", () => {
  // Two entries: a single-model listing is written into the field by the
  // fetch itself (see ModelForm), so Enter has to be what chooses here.
  const preview = { models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] };

  async function mount() {
    const client = new StubClient().reply(preview).asClient();
    let view;
    await act(async () => {
      view = create(
        <ModelForm
          client={client}
          onCancel={() => {}}
          onConfigured={() => {}}
          onProvidersChanged={() => {}}
          presets={[]}
          providers={[]}
          submitLabel="save"
        />,
      );
    });
    return { client, view };
  }

  function field(view: { root: { findAllByType(type: string): Array<{ props: Record<string, unknown> }> } }) {
    const inputs = view.root.findAllByType("input");
    return {
      apiKey: inputs.find((input) => input.props.type === "password")!,
      baseUrl: inputs.find((input) => input.props.role === undefined && input.props.type !== "password")!,
      combobox: inputs.find((input) => input.props.role === "combobox")!,
    };
  }

  it("does not pick the highlighted model for the Enter that accepts a candidate", async () => {
    const { view } = await mount();
    try {
      const before = field(view);
      await act(async () => {
        before.baseUrl.props.onChange({ target: { value: "https://api.example.test" } });
        before.apiKey.props.onChange({ target: { value: "sk-test" } });
      });
      const fetchModels = view.root
        .findAllByType("button")
        .find((button) => (button.children as Array<string>).join("") === TEXT.wizard.provider.fetch)!;
      await act(async () => { fetchModels.props.onClick(); });
      const combobox = field(view).combobox;
      const arrowDown = { key: "ArrowDown", preventDefault: () => {}, stopPropagation: () => {} };
      // First ArrowDown opens the listing, second highlights its first entry.
      await act(async () => { combobox.props.onKeyDown(arrowDown); });
      await act(async () => { field(view).combobox.props.onKeyDown(arrowDown); });
      const { event } = enter({ isComposing: true, nativeEvent: { isComposing: true } });
      await act(async () => { field(view).combobox.props.onKeyDown(event); });
      // The field still holds what the user typed, not the first listing entry
      // the candidate-confirming Enter happened to be over.
      assert.equal(field(view).combobox.props.value, "");
    } finally {
      await act(async () => { view.unmount(); });
    }
  });

  it("picks the highlighted model once the composition has ended", async () => {
    const { view } = await mount();
    try {
      const before = field(view);
      await act(async () => {
        before.baseUrl.props.onChange({ target: { value: "https://api.example.test" } });
        before.apiKey.props.onChange({ target: { value: "sk-test" } });
      });
      const fetchModels = view.root
        .findAllByType("button")
        .find((button) => (button.children as Array<string>).join("") === TEXT.wizard.provider.fetch)!;
      await act(async () => { fetchModels.props.onClick(); });
      const combobox = field(view).combobox;
      const arrowDown = { key: "ArrowDown", preventDefault: () => {}, stopPropagation: () => {} };
      await act(async () => { combobox.props.onKeyDown(arrowDown); });
      await act(async () => { field(view).combobox.props.onKeyDown(arrowDown); });
      const { event } = enter({ isComposing: false, nativeEvent: { isComposing: false } });
      await act(async () => { field(view).combobox.props.onKeyDown(event); });
      assert.equal(field(view).combobox.props.value, "gpt-4o-mini");
    } finally {
      await act(async () => { view.unmount(); });
    }
  });
});
