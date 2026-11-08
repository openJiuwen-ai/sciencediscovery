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
import React from "react";

import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";
import { ApiRequestError, type ApiClient } from "../src/api/client.js";
import type { ExportOperation } from "../src/api/research-package.js";
import type { SessionDetail } from "../src/api/types.js";
import { ResearchPackage } from "../src/views/ResearchPackage.js";

// `apps/desktop` has no DOM test environment; the effect under test touches
// `document` only for dialog focus/escape wiring, which this test never drives.
const realDocument = globalThis.document;
globalThis.document = {
  activeElement: null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
} as unknown as Document;

/** Captures poll timers without letting their 1 s cadence fire. */
function clock(): { armed: () => number; fire: () => Promise<void>; restore: () => void } {
  const armed = new Map<number, () => void>();
  let nextId = 1;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((callback: () => void) => {
    const id = nextId;
    nextId += 1;
    armed.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    armed.delete(id);
  }) as unknown as typeof clearTimeout;
  return {
    armed: () => armed.size,
    fire: async () => {
      const entry = [...armed.entries()][0];
      assert.ok(entry, "a poll was armed");
      armed.delete(entry[0]);
      const [, callback] = entry;
      await act(async () => {
        callback();
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
      });
    },
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

/** Fake client that answers the export-flow endpoints and hands each poll read
 *  to the caller's queue in order. */
function client(reads: Array<() => Promise<ExportOperation>>): ApiClient {
  return {
    request: async (path: string, options?: { method?: string }) => {
      if (path.includes("/preview?")) return { revision: "r1", estimatedBytes: 1024, files: [], omissions: [] };
      if (path.endsWith("/exports") && options?.method === "POST") return { id: "export-1", status: "running" } as ExportOperation;
      if (path.includes("/exports/export-1") && !path.includes("/download")) {
        const next = reads.shift();
        assert.ok(next, `unexpected export poll read: ${path}`);
        return next();
      }
      throw new Error(`unexpected request: ${path}`);
    },
  } as unknown as ApiClient;
}

/** Drives the export flow: render, let the preview resolve, start the export,
 *  then let the poll run. */
async function mountExport(client: ApiClient): Promise<{ renderer: ReactTestRenderer; timers: ReturnType<typeof clock> }> {
  const timers = clock();
  const renderer = await act(async () => create(
    React.createElement(ResearchPackage, {
      client,
      request: { kind: "export", projectId: "p" },
      projects: [],
      detail: { id: "session-1" } as SessionDetail,
      onOpen: () => {},
      onRefresh: async () => {},
    }),
  ));
  return { renderer, timers };
}

test("the export poll settles its own transient notice without carrying shared errors", async () => {
  const api = client([
    () => { throw new ApiRequestError("legacy_unavailable", 502); },
    () => Promise.resolve({ id: "export-1", status: "completed", filename: "x.sdresearch" } as ExportOperation),
  ]);
  const { renderer, timers } = await mountExport(api);
  try {
    // Let the preview effect resolve so the start button becomes enabled.
    await act(async () => {
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });
    const start = renderer.root.findAllByProps({ className: "primary-button" }).find((node) => node.props.onClick && node.props.disabled === false);
    assert.ok(start, "the start-export button is enabled once the preview resolves");
    await act(async () => { (start!.props.onClick as () => void)(); });

    // The running export arms one poll; the first read is a legacy outage.
    assert.equal(timers.armed(), 1);
    await timers.fire();
    const alert = () => renderer.root.findAllByProps({ className: "research-package-error" });
    assert.equal(alert().length, 1, "the legacy_unavailable notice is shown");

    // The next read completes: the poll clears its own notice and stops.
    await timers.fire();
    assert.equal(alert().length, 0, "the transient notice is cleared once the export completes");
    assert.equal(timers.armed(), 0, "the poll stops on a terminal task");
    renderer.unmount();
  } finally {
    timers.restore();
    globalThis.document = realDocument;
  }
});
