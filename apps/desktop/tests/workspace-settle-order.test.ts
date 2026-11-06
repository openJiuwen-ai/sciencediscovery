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
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { createElement } from "react";

import { act, create } from "./support/dom-renderer.js";
import type { ApiClient } from "../src/api/client.js";
import { useWorkspace } from "../src/app/use-workspace.js";

// The app's toasts arm a `window.setTimeout`, and `act` needs telling that it
// is what flushes effects here: neither exists in this process, which is a
// node test rather than a browser one.
const globals = globalThis as { window?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
// A toast's own timer is eight seconds long and would outlive the case; the
// fake only has to accept the call.
globals.window = {
  setTimeout: (callback: () => void, ms: number) => {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return timer;
  },
};
globals.IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Enough microtasks and macrotasks for one turn of a send's own chain. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function detail(messages: ReadonlyArray<{ content: string; role: string }>) {
  return {
    id: "s",
    messages: messages.map((message, index) => ({
      ...message,
      createdAt: "2026-01-01T00:00:00.000Z",
      id: `m${index}`,
    })),
    modelId: "m",
    projectId: "p",
  } as never;
}

/**
 * A backend that answers only what this case needs, and holds the reads a
 * `settle` makes so a test can land them after the next send.
 *
 * `token` is empty on purpose: that is what keeps `useWorkspace` from booting
 * (the credential gate has nothing to check), so the case drives the actions
 * directly instead of standing up a whole workspace.
 */
function fakeBackend() {
  /** Resolve functions for the session reads, in the order they were made. */
  const reads: Array<(value: unknown) => void> = [];
  let streams = 0;
  const client = {
    token: "",
    request: (path: string) => {
      if (path.endsWith("/runs")) return Promise.resolve([]);
      if (/^\/api\/sessions\/[^/]+$/.test(path)) {
        const read = deferred<unknown>();
        reads.push(read.resolve);
        return read.promise;
      }
      // The panel and the sidebar are beside the point here; both paths
      // tolerate a failed read.
      return Promise.reject(new Error(`unexpected ${path}`));
    },
    fetchStream: () => {
      streams += 1;
      // The first two turns end at once, so both sends start a settle. The third
      // stream is left hanging so nothing settles behind the case's back.
      if (streams <= 2) return Promise.resolve(new Response(""));
      return new Promise<Response>(() => {});
    },
  };
  return { client: client as unknown as ApiClient, reads };
}

const contents = (handle: { state: { detail?: { messages: Array<{ content: string }> } } }) =>
  handle.state.detail?.messages.map((message) => message.content);

test("a settle that lands after a newer one does not put its older transcript back", async () => {
  const backend = fakeBackend();
  let handle: ReturnType<typeof useWorkspace> | undefined;

  function Harness(props: { client: ApiClient }) {
    handle = useWorkspace(props.client, () => {});
    return null;
  }

  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(createElement(Harness, { client: backend.client }));
  });

  const FIRST = "/evolve-design --algorithm puct 一";
  const SECOND = "/evolve-design --algorithm puct 二";
  const ANSWER = "answer 2";

  // A Session with one command already persisted: its own read, held.
  const opened = handle!.actions.openSession("s");
  await act(async () => {
    await tick();
  });
  assert.equal(backend.reads.length, 1);
  backend.reads.shift()!(detail([{ content: FIRST, role: "user" }]));
  await act(async () => {
    await opened;
  });
  assert.deepEqual(contents(handle!), [FIRST]);

  // A turn is sent and ends, so its `settle` is now reading. `running` is
  // already false — the composer accepts a message here, which is exactly the
  // window the two settles overlap in.
  void handle!.actions.send(FIRST);
  await act(async () => {
    await tick();
  });
  assert.equal(backend.reads.length, 1, "the first settle's session read is in flight");

  // The second message goes out while the first settle is still reading, and
  // its own turn ends at once too, so a second settle starts — the newer one.
  void handle!.actions.send(SECOND);
  await act(async () => {
    await tick();
  });
  assert.equal(backend.reads.length, 2, "the newer settle's session read is in flight");

  // The newer settle lands first, with both turns in it.
  backend.reads.splice(1, 1)[0](
    detail([
      { content: FIRST, role: "user" },
      { content: SECOND, role: "user" },
      { content: ANSWER, role: "assistant" },
    ]),
  );
  await act(async () => {
    await tick();
  });
  assert.deepEqual(contents(handle!), [FIRST, SECOND, ANSWER]);

  // Then the older one lands, with the transcript as it was before the second
  // message existed. Its reads predate everything the newer settle read, so
  // writing them now would take the answer off the screen until the next turn
  // — and put the design anchor back on the previous design.
  backend.reads.splice(0, 1)[0](detail([{ content: FIRST, role: "user" }]));
  await act(async () => {
    await tick();
  });
  assert.deepEqual(contents(handle!), [FIRST, SECOND, ANSWER], "the older settle did not write");
  renderer!.unmount();
});
