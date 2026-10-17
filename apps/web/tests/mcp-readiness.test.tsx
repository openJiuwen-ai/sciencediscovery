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
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ApiClient } from "../src/api.js";
import { useMcpReadiness } from "../src/composer/useMcpReadiness.js";

type Listing = Awaited<ReturnType<ApiClient["listMcpSources"]>>;
const unavailable: Listing = [{ manifest: { id: "pubmed" } as Listing[number]["manifest"], status: { sourceId: "pubmed", status: "unavailable", availableTools: [], missingTools: ["search"], lastCheckedAt: "now", error: "offline" } }];
const ready = [{ ...unavailable[0]!, status: { ...unavailable[0]!.status, status: "ready", availableTools: ["search"], missingTools: [], error: undefined } }] as Listing;

test("catalog reload refreshes readiness after repair and a failed read never preserves a ready badge", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const calls: string[] = [];
  let items = unavailable, fail = false;
  let hook!: ReturnType<typeof useMcpReadiness>;
  const client = { listMcpSources: async () => { calls.push("list"); if (fail) throw new Error("catalog offline"); return items; },
    reloadMcpSources: async () => { calls.push("reload"); items = ready; } };
  function Harness() { hook = useMcpReadiness(client); return null; }
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(Harness)); });
  try {
    await act(async () => { await hook.refresh(); });
    assert.equal(hook.sourceStatuses.pubmed?.status, "unavailable");
    await act(async () => { await hook.refresh(true); });
    assert.deepEqual(calls, ["list", "reload", "list"]);
    assert.equal(hook.sourceStatuses.pubmed?.status, "ready");
    fail = true;
    await act(async () => { await hook.refresh(); });
    assert.match(hook.error!, /catalog offline/);
    assert.deepEqual(hook.sourceStatuses, {});
    assert.equal(hook.sources[0]?.id, "pubmed", "retain manifests for settings while readiness is unknown");
    fail = false;
    await act(async () => { await hook.refresh(); });
    assert.equal(hook.error, undefined);
    assert.equal(hook.sourceStatuses.pubmed?.status, "ready");
  } finally { await act(async () => view.unmount()); }
});

test("an older catalog read cannot replace a newer settings update", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let resolve!: (items: Listing) => void;
  let hook!: ReturnType<typeof useMcpReadiness>;
  const client = { listMcpSources: () => new Promise<Listing>(done => { resolve = done; }), reloadMcpSources: async () => undefined };
  function Harness() { hook = useMcpReadiness(client); return null; }
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(Harness)); });
  try {
    let pending!: Promise<void>;
    await act(async () => { pending = hook.refresh(); });
    await act(async () => { hook.applyListing(ready); });
    await act(async () => { resolve(unavailable); await pending; });
    assert.equal(hook.sourceStatuses.pubmed?.status, "ready");
  } finally { await act(async () => view.unmount()); }
});
