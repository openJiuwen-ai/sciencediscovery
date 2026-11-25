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

/**
 * The create dialog's gate, at the moment it opens.
 *
 * The dialog is handed the runtime status the app read earlier; the bug was
 * trusting it. A sidecar that died between the app start and opening
 * 新建程序演进实验 still read as 就绪, so the "runtime cannot run the search"
 * banner was gone and 开始设计 was enabled — a design turn paid for a runtime
 * that could not execute it. Opening the form now re-reads the status, which is
 * what makes a dead runtime block the button.
 *
 * These cases mount the real hook and the real dialog together, so the
 * assertion is about what a person sees: the banner in the tree, and the
 * button's `disabled`.
 */

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { createElement } from "react";

import { act, create, type ReactTestInstance, type ReactTestRenderer } from "./support/dom-renderer.js";
import type { ApiClient } from "../src/api/client.js";
import type { EvolveStatus } from "../src/api/evolve.js";
import { useEvolve } from "../src/evolve/use-evolve.js";
import { TEXT } from "../src/text.js";
import { EvolveCreateDialog } from "../src/views/evolve/EvolveCreateDialog.js";

/** Answers `/api/evolve/status` from `statuses` in order, repeating the last
 *  one afterwards; the run list is empty, which is what a session with no run
 *  answers. */
function client(statuses: EvolveStatus[]): ApiClient {
  const queue = [...statuses];
  let last = statuses[statuses.length - 1];
  return {
    request: async (path: string) => {
      if (path === "/api/evolve/status") {
        if (queue.length > 0) last = queue.shift() ?? last;
        return last;
      }
      if (path.startsWith("/api/evolve/runs")) return [];
      throw new Error(`unexpected read: ${path}`);
    },
  } as unknown as ApiClient;
}

/** The app as the user has it: the hook is read at the top, and the dialog is
 *  mounted only once they open it. */
function Harness({ api, open }: { api: ApiClient; open: boolean }) {
  const evolve = useEvolve(api, "s");
  if (!open) return null;
  return createElement(EvolveCreateDialog, {
    activeRun: false,
    archived: false,
    error: evolve.error,
    initialGoal: "让压缩比更高且完全无损",
    initializing: evolve.initializing,
    onClose: () => {},
    onInitialize: () => {},
    onRefreshStatus: evolve.refreshStatus,
    onSend: () => {},
    running: false,
    status: evolve.status,
  });
}

function text(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map((child) => text(child)).join("");
}

function findSubmit(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.find((node) => node.type === "button"
    && node.props.className === "evolve-create-submit");
}

/** The banner that says the runtime cannot run the search. The unisolated
 *  notice is also `role="note"`, so the class is what tells them apart. */
function runtimeBanner(renderer: ReactTestRenderer): ReactTestInstance | undefined {
  return renderer.root.findAll((node) => node.type === "div"
    && node.props.role === "note"
    && typeof node.props.className === "string"
    && node.props.className.split(" ").includes("evolve-create-runtime"))[0];
}

function mount(api: ApiClient): Promise<ReactTestRenderer> {
  return act(async () => create(createElement(Harness, { api, open: false })));
}

/** Opening the form is a re-render that mounts the dialog, whose own effect is
 *  the status re-read; the read's microtasks have to drain inside the same
 *  `act`. */
async function open(renderer: ReactTestRenderer, api: ApiClient): Promise<void> {
  await act(async () => {
    renderer.update(createElement(Harness, { api, open: true }));
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
  });
}

test("opening the dialog re-reads the runtime, so a sidecar that died since the app started blocks 开始设计", async () => {
  // The app read `ready` at start; the sidecar died before the form opened. The
  // second answer is what the user must see.
  const api = client([
    { canInitialize: true, state: "ready" },
    { canInitialize: false, state: "error" },
  ]);
  const renderer = await mount(api);
  await open(renderer, api);

  const banner = runtimeBanner(renderer);
  assert.ok(banner, "the runtime banner is shown");
  assert.match(text(banner), new RegExp(TEXT.evolve.setup.bannerTitle.slice(0, 8)));

  const submit = findSubmit(renderer);
  assert.equal(text(submit), TEXT.evolve.create.send);
  assert.equal(submit.props.disabled, true,
    "开始设计 cannot start a design on a runtime that is not ready");

  await act(async () => {
    renderer.unmount();
  });
});

test("a live runtime keeps the form open for business when the dialog opens", async () => {
  // The other half: the re-read must not block a runtime that answers ready,
  // which would make every open a false alarm.
  const api = client([
    { canInitialize: true, sandbox: "bwrap", state: "ready" },
    { canInitialize: true, sandbox: "bwrap", state: "ready" },
  ]);
  const renderer = await mount(api);
  await open(renderer, api);

  assert.equal(runtimeBanner(renderer), undefined, "no banner over a ready runtime");
  assert.equal(findSubmit(renderer).props.disabled, false);

  await act(async () => {
    renderer.unmount();
  });
});
