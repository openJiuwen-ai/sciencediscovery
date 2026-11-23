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
// The runner compiles JSX with the classic runtime.
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { ApiClient } from "../src/api/client.js";
import type {
  ComposerReference,
  MemoryGraphChainResult,
  MemoryGraphMatchResponse,
} from "../src/api/types.js";
import { TEXT } from "../src/text.js";
import { MemoryCardContent } from "../src/views/MemoryCardDialog.js";

const REPORT_SESSION = "94d52ab1-1718-416f-9675-85d2117e7bb0";
const OTHER_SESSION = "789fd699-f16a-4248-a59c-4fd6e8fa10d7";

const CROSS_SESSION_EVIDENCE = {
  createdAt: "2026-11-20T10:00:00.000Z",
  excerpt: "Methane conversion rose to 92%",
  extra: {
    content: "Methane conversion rose to 92% at 400 °C",
    evidence_type: "measurement",
    locator: "Figure 2",
  },
  id: "978921ef-ac48-4bd2-90c8-fb74d7537da9",
  label: "Evidence" as const,
  sessionId: OTHER_SESSION,
};

const EMPTY: MemoryGraphMatchResponse = { hits: [], total: 0, truncated: false };

interface Call {
  body: Record<string, unknown>;
  path: string;
}

/** A client that answers the card's two reads from prepared answers, keyed by
 *  whether the node-type query carried a Session. */
function fakeClient(answers: {
  unscoped: MemoryGraphMatchResponse;
  scoped: MemoryGraphMatchResponse;
  chain?: MemoryGraphChainResult;
}): { calls: Call[]; client: ApiClient } {
  const calls: Call[] = [];
  const client = {
    request: async (path: string, init?: RequestInit) => {
      const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ body, path });
      if (path === "/api/memory/query/by-node-type") {
        return body.session_id === undefined ? answers.unscoped : answers.scoped;
      }
      if (path === "/api/memory/query/chain") {
        return answers.chain ?? { edges: [], nodes: [], total: 0, truncated: false };
      }
      throw new Error(`unmocked ${path}`);
    },
  };
  return { calls, client: client as unknown as ApiClient };
}

function markup(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

async function mount(client: ApiClient, reference: ComposerReference): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  // One act for the mount and the two reads the effect starts: the resolver's
  // continuation must resolve inside the same scope, or React schedules the
  // state update outside it and the following test can see a stale tree.
  await act(async () => {
    renderer = create(
      <MemoryCardContent
        client={client}
        onClose={() => {}}
        onOpenSettings={() => {}}
        reference={reference}
        sessionId={REPORT_SESSION}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return renderer!;
}

/** Mount, run the assertions against the settled card, then unmount: a tree
 *  left mounted would keep applying state updates while the next case runs. */
async function withCard(
  client: ApiClient,
  reference: ComposerReference,
  run: (renderer: ReactTestRenderer) => void | Promise<void>,
): Promise<void> {
  const renderer = await mount(client, reference);
  try {
    await run(renderer);
  } finally {
    await act(async () => {
      renderer.unmount();
    });
  }
}

async function pressTab(renderer: ReactTestRenderer, label: string): Promise<void> {
  const button = renderer.root.findAllByType("button")
    .find((candidate) => candidate.children.join("") === label);
  assert.ok(button, `the card offers a ${label} tab`);
  await act(async () => {
    button!.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("a citation of a node created in another Session", () => {
  const reference: ComposerReference = {
    id: CROSS_SESSION_EVIDENCE.id,
    kind: "evidence",
    label: "evidence1",
  };
  const chain: MemoryGraphChainResult = {
    edges: [{ source: "sf-paper", target: CROSS_SESSION_EVIDENCE.id, type: "extracts" }],
    nodes: [
      { extra: {}, id: CROSS_SESSION_EVIDENCE.id, label: "Evidence", sessionId: OTHER_SESSION },
      {
        extra: { title: "Methane activation over zeolites" },
        id: "sf-paper",
        label: "Paper",
        sessionId: OTHER_SESSION,
      },
    ],
    total: 2,
    truncated: false,
  };

  it("is read without the report's Session before it is called missing", async () => {
    const { calls, client } = fakeClient({
      chain,
      scoped: EMPTY,
      unscoped: { hits: [CROSS_SESSION_EVIDENCE], total: 1, truncated: false },
    });
    await withCard(client, reference, (renderer) => {
      const text = markup(renderer);

      assert.ok(text.includes(CROSS_SESSION_EVIDENCE.extra.content), "the cited Evidence's content is shown");
      assert.ok(!text.includes(TEXT.memory.notFoundTitle), "a node that exists is not reported missing");
      // The scoped read still comes first, and the widening read names no Session.
      const reads = calls.filter((call) => call.path === "/api/memory/query/by-node-type");
      assert.equal(reads.length, 2, "one scoped read, then one unscoped read");
      assert.equal(reads[0]!.body.session_id, REPORT_SESSION);
      assert.equal("session_id" in reads[1]!.body, false);
    });
  });

  it("shows its provenance chain from the Session that owns it", async () => {
    const { calls, client } = fakeClient({
      chain,
      scoped: EMPTY,
      unscoped: { hits: [CROSS_SESSION_EVIDENCE], total: 1, truncated: false },
    });
    await withCard(client, reference, async (renderer) => {
      await pressTab(renderer, TEXT.memory.provenanceTab);

      assert.ok(markup(renderer).includes("Methane activation over zeolites"), "the source paper is shown");
      const hop = calls.find((call) => call.path === "/api/memory/query/chain");
      assert.equal(hop?.body.node_id, CROSS_SESSION_EVIDENCE.id);
      assert.equal(hop?.body.session_id, OTHER_SESSION, "the chain is read in the node's own Session");
    });
  });

  it("does not widen a citation that names its own Session", async () => {
    const { calls, client } = fakeClient({ scoped: EMPTY, unscoped: { hits: [CROSS_SESSION_EVIDENCE], total: 1, truncated: false } });
    await withCard(client, { ...reference, sessionId: OTHER_SESSION }, (renderer) => {
      assert.ok(markup(renderer).includes(TEXT.memory.notFoundTitle));
      assert.equal(calls.filter((call) => call.path === "/api/memory/query/by-node-type").length, 1,
        "an authoritative Session is not second-guessed");
    });
  });
});

describe("a citation no Session has", () => {
  it("is reported as not found, without claiming deletion or an outage", async () => {
    const { client } = fakeClient({ scoped: EMPTY, unscoped: EMPTY });
    await withCard(client, { id: "never-recorded", kind: "evidence", label: "evidence9" }, (renderer) => {
      const text = markup(renderer);

      assert.ok(text.includes(TEXT.memory.notFoundTitle));
      assert.ok(text.includes(TEXT.memory.notFoundBody));
      // The copy must not merge a missing record with data loss or a dead service.
      assert.doesNotMatch(TEXT.memory.notFoundBody, /deleted|删除|unavailable|不可用/);
      assert.ok(!text.includes(TEXT.memory.unreachableTitle), "a real answer is not an outage");
    });
  });
});

describe("a graph that could not answer", () => {
  for (const reason of ["memory_graph_query_limit", "memory_graph_unreachable"]) {
    it(`stays unavailable on ${reason} and is not read again as unscoped`, async () => {
      const { calls, client } = fakeClient({
        scoped: { hits: [], reason, total: 0, truncated: false },
        unscoped: { hits: [CROSS_SESSION_EVIDENCE], total: 1, truncated: false },
      });
      await withCard(client, { id: CROSS_SESSION_EVIDENCE.id, kind: "evidence", label: "evidence1" }, (renderer) => {
        const text = markup(renderer);

        assert.ok(text.includes(TEXT.memory.unreachableTitle));
        assert.ok(!text.includes(TEXT.memory.notFoundTitle), "cannot answer is not no such record");
        assert.equal(calls.filter((call) => call.path === "/api/memory/query/by-node-type").length, 1,
          "a refusal is not widened into a second refusal");
      });
    });
  }

  it("reports a rejected internal token as such, not as a timeout or a missing node", async () => {
    const { client } = fakeClient({
      scoped: { hits: [], reason: "memory_graph_unauthorized", total: 0, truncated: false },
      unscoped: { hits: [CROSS_SESSION_EVIDENCE], total: 1, truncated: false },
    });
    await withCard(client, { id: CROSS_SESSION_EVIDENCE.id, kind: "evidence", label: "evidence1" }, (renderer) => {
      const text = markup(renderer);

      assert.ok(text.includes(TEXT.memory.authTitle), "the card names the rejected credential");
      assert.ok(!text.includes(TEXT.memory.unreachableTitle), "a rejected token is not a timeout");
      assert.ok(!text.includes(TEXT.memory.notFoundTitle), "an auth refusal proves nothing about the node");
      assert.ok(text.includes(TEXT.memory.openSettings), "settings is the only route, not a retry");
    });
  });

  it("stays unavailable when the widening read is the one refused", async () => {
    const { client } = fakeClient({
      scoped: EMPTY,
      unscoped: { hits: [], reason: "memory_graph_query_limit", total: 0, truncated: false },
    });
    await withCard(client, { id: CROSS_SESSION_EVIDENCE.id, kind: "evidence", label: "evidence1" }, (renderer) => {
      const text = markup(renderer);

      assert.ok(text.includes(TEXT.memory.unreachableTitle));
      assert.ok(!text.includes(TEXT.memory.notFoundTitle));
    });
  });
});

describe("a read that answered with a truncated page", () => {
  const reference: ComposerReference = {
    id: CROSS_SESSION_EVIDENCE.id,
    kind: "evidence",
    label: "evidence1",
  };
  // The sidecar caps a node-type read at 500 nodes and flags the cut. What the
  // page does not hold is not thereby absent from memory.
  const anotherEvidence = {
    ...CROSS_SESSION_EVIDENCE,
    excerpt: "A different claim on the same page",
    extra: { content: "A different claim on the same page" },
    id: "3b1c0a6e-2f1f-4e5a-9d3c-6f2c8a7b5d10",
  };

  it("is not reported as not found, on the scoped read or the widened one", async () => {
    const { calls, client } = fakeClient({
      scoped: { hits: [], total: 0, truncated: true },
      unscoped: { hits: [], total: 0, truncated: true },
    });
    await withCard(client, reference, (renderer) => {
      const text = markup(renderer);

      assert.ok(!text.includes(TEXT.memory.notFoundTitle), "a cut page is not proof that nothing exists");
      assert.ok(text.includes(TEXT.memory.unlocatedTitle), "the card says it cannot locate the citation");
      assert.equal(calls.filter((call) => call.path === "/api/memory/query/by-node-type").length, 2,
        "the widened read is still worth asking");
    });
  });

  it("does not render not-found when the truncated page holds no matching hit", async () => {
    const { client } = fakeClient({
      scoped: { hits: [anotherEvidence], total: 1, truncated: true },
      unscoped: { hits: [anotherEvidence], total: 1, truncated: true },
    });
    await withCard(client, reference, (renderer) => {
      const text = markup(renderer);

      assert.ok(!text.includes(anotherEvidence.extra.content), "a different node is not shown as the cited one");
      assert.ok(!text.includes(TEXT.memory.notFoundTitle), "the cited node may be past the 500-node cut");
      assert.ok(text.includes(TEXT.memory.unlocatedTitle));
    });
  });

  it("still opens the cited node when it is on the page", async () => {
    const { client } = fakeClient({
      scoped: { hits: [anotherEvidence], total: 1, truncated: true },
      unscoped: { hits: [anotherEvidence, CROSS_SESSION_EVIDENCE], total: 2, truncated: true },
    });
    await withCard(client, reference, (renderer) => {
      assert.ok(markup(renderer).includes(CROSS_SESSION_EVIDENCE.extra.content));
    });
  });
});

describe("a DbRecord citation that names no Session", () => {
  const record = {
    createdAt: "2026-11-20T10:00:00.000Z",
    excerpt: "A record from another Session",
    extra: { identifier: "10.1021/jacs.6b00001", title: "A record from another Session" },
    id: "10.1021/jacs.6b00001",
    label: "DbRecord" as const,
    sessionId: OTHER_SESSION,
  };

  it("does not accept a same-id record that belongs to another Session", async () => {
    const { calls, client } = fakeClient({
      scoped: EMPTY,
      unscoped: { hits: [record], total: 1, truncated: false },
    });
    await withCard(client, { id: record.id, kind: "dbrecord", label: "record1" }, (renderer) => {
      const text = markup(renderer);

      assert.ok(!text.includes(record.extra.title), "a foreign record is not rendered as the cited one");
      assert.ok(!text.includes(TEXT.memory.notFoundTitle), "the citation is not proven absent either");
      assert.ok(text.includes(TEXT.memory.unlocatedTitle));
      assert.equal(calls.filter((call) => call.path === "/api/memory/query/by-node-type").length, 1,
        "an id several Sessions share is not widened");
    });
  });

  it("still opens a DbRecord citation that names its owning Session", async () => {
    const { client } = fakeClient({ scoped: { hits: [record], total: 1, truncated: false }, unscoped: EMPTY });
    await withCard(client, { id: record.id, kind: "dbrecord", label: "record1", sessionId: OTHER_SESSION }, (renderer) => {
      const text = markup(renderer);
      assert.ok(text.includes(record.extra.title));
      assert.ok(!text.includes(TEXT.memory.unlocatedTitle));
    });
  });
});
