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

// The three web Enter sites that act on the message/field rather than on a
// navigation: the SSH key browser's location field, the inline rename field,
// and the composer's send. The first two mount; the composer lives inside
// `App.tsx`, which needs a live client and the whole session shell, so its
// wiring is pinned by reading the handler it keeps.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { ApiClient } from "../src/api.js";
import { SshKeyFileField } from "../src/SshKeyFileField.js";
import { InlineRenameInput } from "../src/session/ManagementControls.js";

const listing = { directory: "~/.ssh", entries: [], nextOffset: null, parentDirectory: null };

/** The part of a keydown these handlers read, plus the two things they do to
 *  it: `preventDefault` and `currentTarget.blur` (which is what commits the
 *  rename field in a real DOM). */
function enter(fields: Record<string, unknown> = {}) {
  const seen = { blurred: false, prevented: false };
  const event = {
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    nativeEvent: { isComposing: false },
    preventDefault: () => { seen.prevented = true; },
    stopPropagation: () => {},
    currentTarget: { blur: () => { seen.blurred = true; } },
    ...fields,
  };
  return { event, seen };
}

/** The browser dialog keeps a real `<dialog>` ref and calls `showModal` when it
 *  opens; the test renderer's mock host needs those two methods. */
const nodeMock = () => ({
  close: () => {},
  focus: () => {},
  showModal: () => {},
});

describe("SSH key browser", () => {
  it("does not browse again for the Enter that accepts an IME candidate", async () => {
    const browsed: string[] = [];
    const client = {
      listSshKeyFiles: (path?: string) => {
        browsed.push(path ?? "");
        return Promise.resolve(listing);
      },
    } as unknown as ApiClient;
    let view: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(SshKeyFileField, {
          client,
          label: "Private key",
          onChange: () => {},
          placeholder: "~/.ssh",
          value: "~/.ssh",
        }),
        { createNodeMock: nodeMock },
      );
    });
    try {
      const open = view!.root.findAllByType("button")[0]!;
      await act(async () => { open.props.onClick(); });
      browsed.length = 0;

      const location = view!.root
        .findAllByType("input")
        .find((input) => String(input.props.id ?? "").endsWith("-location"))!;
      const { event } = enter({ isComposing: true, nativeEvent: { isComposing: true }, keyCode: 13 });
      await act(async () => { location.props.onKeyDown(event); });
      // The user is still choosing "蛋白"; the Enter confirms the candidate and
      // must not ask the service for another listing.
      assert.deepEqual(browsed, []);
    } finally {
      await act(async () => view!.unmount());
    }
  });

  it("browses on an Enter after the candidate has been accepted", async () => {
    const browsed: string[] = [];
    const client = {
      listSshKeyFiles: (path?: string) => {
        browsed.push(path ?? "");
        return Promise.resolve(listing);
      },
    } as unknown as ApiClient;
    let view: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(SshKeyFileField, {
          client,
          label: "Private key",
          onChange: () => {},
          placeholder: "~/.ssh",
          value: "~/.ssh",
        }),
        { createNodeMock: nodeMock },
      );
    });
    try {
      const open = view!.root.findAllByType("button")[0]!;
      await act(async () => { open.props.onClick(); });
      browsed.length = 0;
      const location = view!.root
        .findAllByType("input")
        .find((input) => String(input.props.id ?? "").endsWith("-location"))!;
      const { event } = enter({ isComposing: false, nativeEvent: { isComposing: false } });
      await act(async () => { location.props.onKeyDown(event); });
      assert.deepEqual(browsed, ["~/.ssh"]);
    } finally {
      await act(async () => view!.unmount());
    }
  });
});

describe("inline rename field", () => {
  it("does not blur (and so does not commit) for the Enter that accepts a candidate", async () => {
    const committed: string[] = [];
    let view: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(InlineRenameInput, {
          ariaLabel: "Rename session",
          onChange: () => {},
          onCommit: (value: string) => { committed.push(value); },
          value: "protein ",
        }),
      );
    });
    try {
      const input = view!.root.findAllByType("input")[0]!;
      const { event, seen } = enter({ isComposing: true, nativeEvent: { isComposing: true } });
      await act(async () => { input.props.onKeyDown(event); });
      assert.equal(seen.blurred, false);
      assert.deepEqual(committed, []);
    } finally {
      await act(async () => view!.unmount());
    }
  });

  it("does not treat the keyCode 229 Enter as the user's when no composition flag is set", async () => {
    // The shape this guards is the half-guard: reading only
    // `nativeEvent.isComposing` misses Windows IMEs, which report the
    // confirming Enter as keyCode 229 with no flag at all.
    const committed: string[] = [];
    let view: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(InlineRenameInput, {
          ariaLabel: "Rename session",
          onChange: () => {},
          onCommit: (value: string) => { committed.push(value); },
          value: "protein ",
        }),
      );
    });
    try {
      const input = view!.root.findAllByType("input")[0]!;
      const { event, seen } = enter({ isComposing: false, keyCode: 229, nativeEvent: { isComposing: false } });
      await act(async () => { input.props.onKeyDown(event); });
      assert.equal(seen.blurred, false);
    } finally {
      await act(async () => view!.unmount());
    }
  });

  it("commits once the composition has ended", async () => {
    const committed: string[] = [];
    let view: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(InlineRenameInput, {
          ariaLabel: "Rename session",
          onChange: () => {},
          onCommit: (value: string) => { committed.push(value); },
          value: "protein ",
        }),
      );
    });
    try {
      const input = view!.root.findAllByType("input")[0]!;
      const { event, seen } = enter({ isComposing: false, nativeEvent: { isComposing: false } });
      await act(async () => { input.props.onKeyDown(event); });
      assert.equal(seen.blurred, true);
    } finally {
      await act(async () => view!.unmount());
    }
  });
});

describe("composer send in App", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  it("asks the shared rule whether the Enter is the user's", () => {
    // The composer sits inside the session shell, so the source is where the
    // wiring can be checked without standing up the API behind it.
    assert.match(app, /import \{ commitsOnEnter \} from "\.\/ime-enter\.js";/);
    assert.match(app, /if \(event\.shiftKey \|\| !commitsOnEnter\(event\)\) return;/);
  });

  it("no longer trusts the native composition flag alone", () => {
    assert.doesNotMatch(app, /event\.nativeEvent\.isComposing/);
  });
});
