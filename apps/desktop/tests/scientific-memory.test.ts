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

import {
  artifactIdentity,
  artifactVersionOf,
  evidenceSources,
  matchReferenceHit,
  memoryNodeLink,
  memoryNodeTitle,
  resolveCitation,
} from "../src/app/memory.js";
import type { ComposerReference, MemoryGraphHit, MemoryGraphNode } from "../src/api/types.js";

function hit(overrides: Partial<MemoryGraphHit> & Pick<MemoryGraphHit, "label" | "id">): MemoryGraphHit {
  return {
    excerpt: "",
    extra: {},
    createdAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

function node(overrides: Partial<MemoryGraphNode> & Pick<MemoryGraphNode, "label" | "id">): MemoryGraphNode {
  return { extra: {}, ...overrides };
}

describe("what a citation resolves to", () => {
  const evidence = hit({
    label: "Evidence",
    id: "e1",
    excerpt: "Methane conversion rose",
    extra: { content: "Methane conversion rose to 92%", locator: "Figure 2", evidence_type: "measurement" },
  });
  const artifactV1 = hit({
    label: "Artifact",
    id: "a1#v1",
    extra: { artifact_id: "a1", version: 1, logical_name: "report.md", path: "/runs/one/report.md" },
  });
  const artifactV2 = hit({
    label: "Artifact",
    id: "a1#v2",
    extra: { artifact_id: "a1", version: 2, logical_name: "report.md", path: "/runs/one/report.md" },
  });
  const hits = [evidence, artifactV1, artifactV2];

  it("finds an Evidence by its id", () => {
    const reference: ComposerReference = { id: "e1", kind: "evidence", label: "evidence1" };
    assert.equal(matchReferenceHit(hits, reference), evidence);
  });

  it("pins an Artifact to the version the report cited", () => {
    const reference: ComposerReference = { id: "a1", kind: "artifact", label: "artifact1", version: 1 };
    assert.equal(matchReferenceHit(hits, reference), artifactV1, "v2 is not the cited version");
  });

  it("accepts the first listed version when the citation names none", () => {
    const reference: ComposerReference = { id: "a1", kind: "artifact", label: "artifact1" };
    assert.equal(matchReferenceHit(hits, reference), artifactV1);
  });

  it("never matches a different label with the same id", () => {
    const reference: ComposerReference = { id: "a1", kind: "evidence", label: "evidence1" };
    assert.equal(matchReferenceHit(hits, reference), undefined);
  });

  it("says nothing for a kind the graph has no label for", () => {
    const reference: ComposerReference = { id: "s1", kind: "session", label: "session1" };
    assert.equal(matchReferenceHit(hits, reference), undefined);
  });
});

describe("what a provenance card is called", () => {
  it("uses the label's own name field, then a path's basename", () => {
    assert.equal(memoryNodeTitle(node({ label: "Paper", id: "p", extra: { title: "A paper" } })), "A paper");
    assert.equal(
      memoryNodeTitle(node({ label: "Artifact", id: "a", extra: { path: "/runs/one/report.md" } })),
      "report.md",
    );
    assert.equal(
      memoryNodeTitle(node({ label: "Artifact", id: "a", extra: { logical_name: "report" } })),
      "report",
    );
    assert.equal(memoryNodeTitle(node({ label: "Claim", id: "claim-7" })), "claim-7", "never a blank line");
  });

  it("links only web-shaped nodes", () => {
    assert.equal(
      memoryNodeLink(node({ label: "WebPage", id: "w", extra: { url: "https://example.test/page" } })),
      "https://example.test/page",
    );
    assert.equal(
      memoryNodeLink(node({ label: "SourceFile", id: "f", extra: { path: "/tmp/a.pdf" } })),
      undefined,
    );
  });
});

describe("an Artifact's graph identity", () => {
  it("recovers the artifact id and version from the subgraph id", () => {
    assert.deepEqual(
      artifactIdentity({ label: "Artifact", id: "artifact-1#v3", extra: {} }),
      { artifactId: "artifact-1", version: 3 },
    );
  });

  it("prefers the fields the node carries over the id's encoding", () => {
    assert.deepEqual(
      artifactIdentity({
        label: "Artifact",
        id: "something-else#v9",
        extra: { artifact_id: "artifact-2", version: 4 },
      }),
      { artifactId: "artifact-2", version: 4 },
    );
  });

  it("answers only for Artifact nodes", () => {
    assert.equal(artifactIdentity({ label: "Evidence", id: "evidence-1", extra: {} }), undefined);
    assert.equal(artifactVersionOf(hit({ label: "Evidence", id: "e", extra: { version: 2 } })), 2);
    assert.equal(artifactVersionOf(hit({ label: "Artifact", id: "a#v5" })), 5);
  });
});

describe("an Evidence's provenance", () => {
  const paper = node({ label: "Paper", id: "paper-1" });
  const evidence = node({ label: "Evidence", id: "evidence-1" });

  it("keeps what the evidence was extracted from and drops the evidence itself", () => {
    assert.deepEqual(evidenceSources("evidence-1", [evidence, paper]), [paper]);
  });

  it("deduplicates a source the walk returned twice", () => {
    assert.deepEqual(evidenceSources("evidence-1", [paper, paper]), [paper]);
  });

  it("reports no sources rather than inventing one", () => {
    assert.deepEqual(evidenceSources("evidence-1", [evidence]), []);
  });
});

describe("how a citation is read from the graph", () => {
  const reads: Array<string | undefined> = [];
  const answering = (answers: MemoryGraphHit[][]): ((label: string, sessionId?: string) => Promise<{ hits: MemoryGraphHit[]; total: number; truncated: boolean }>) =>
    async (_label, sessionId) => {
      reads.push(sessionId);
      return { hits: answers.shift() ?? [], total: 0, truncated: false };
    };

  /** Answers in order, each page carrying its own cut-short flag — the sidecar
   *  caps a read at 500 nodes and says so with `truncated`. */
  const paging = (pages: Array<{ hits?: MemoryGraphHit[]; truncated?: boolean }>) =>
    async (_label: string, sessionId?: string) => {
      reads.push(sessionId);
      const page = pages.shift() ?? {};
      return { hits: page.hits ?? [], total: 0, truncated: page.truncated ?? false };
    };

  const evidence: ComposerReference = { id: "e1", kind: "evidence", label: "evidence1" };
  const own = hit({ label: "Evidence", id: "e1", sessionId: "session-own" });

  it("answers from the report's Session without widening", async () => {
    reads.length = 0;
    const result = await resolveCitation(evidence, "session-report", answering([[own]]));
    assert.deepEqual(result, { hit: own, status: "ready" });
    assert.deepEqual(reads, ["session-report"], "a hit in scope is the answer");
  });

  it("widens once, unscoped, when the citation names no Session and the scope is empty", async () => {
    reads.length = 0;
    const elsewhere = hit({ label: "Evidence", id: "e1", sessionId: "session-other" });
    const result = await resolveCitation(evidence, "session-report", answering([[], [elsewhere]]));
    assert.deepEqual(result, { hit: elsewhere, status: "ready" });
    assert.deepEqual(reads, ["session-report", undefined]);
  });

  it("pins an Artifact citation to its version in the widened read too", async () => {
    reads.length = 0;
    const v1 = hit({ label: "Artifact", id: "a1#v1", sessionId: "session-other", extra: { artifact_id: "a1", version: 1 } });
    const v2 = hit({ label: "Artifact", id: "a1#v2", sessionId: "session-other", extra: { artifact_id: "a1", version: 2 } });
    const result = await resolveCitation(
      { id: "a1", kind: "artifact", label: "artifact1", version: 1 },
      "session-report",
      answering([[], [v2, v1]]),
    );
    assert.deepEqual(result, { hit: v1, status: "ready" });
  });

  it("stays missing after both reads found nothing", async () => {
    reads.length = 0;
    const result = await resolveCitation(evidence, "session-report", answering([[], []]));
    assert.deepEqual(result, { status: "missing" });
    assert.deepEqual(reads, ["session-report", undefined]);
  });

  it("does not widen an already unscoped read", async () => {
    reads.length = 0;
    const result = await resolveCitation(evidence, undefined, answering([[]]));
    assert.deepEqual(result, { status: "missing" });
    assert.deepEqual(reads, [undefined]);
  });

  it("carries a refusal through instead of calling it missing", async () => {
    const refused = async () => ({ hits: [], reason: "memory_graph_query_limit", total: 0, truncated: false });
    const result = await resolveCitation(evidence, "session-report", refused);
    assert.deepEqual(result, { reason: "memory_graph_query_limit", status: "unanswered" });
  });

  it("does not call a citation missing when both pages were cut short", async () => {
    reads.length = 0;
    const result = await resolveCitation(evidence, "session-report", paging([
      { truncated: true },
      { truncated: true },
    ]));
    assert.deepEqual(result, { status: "unlocated" }, "a 500-node page is not proof of absence");
    assert.deepEqual(reads, ["session-report", undefined]);
  });

  it("does not call a citation missing when its own Session's page was cut short", async () => {
    reads.length = 0;
    const result = await resolveCitation(
      { ...evidence, sessionId: "session-other" },
      "session-report",
      paging([{ truncated: true }]),
    );
    assert.deepEqual(result, { status: "unlocated" });
    assert.deepEqual(reads, ["session-other"], "an authoritative scope is still not second-guessed");
  });

  it("does not call an already unscoped citation missing when its page was cut short", async () => {
    reads.length = 0;
    const result = await resolveCitation(evidence, undefined, paging([{ truncated: true }]));
    assert.deepEqual(result, { status: "unlocated" });
    assert.deepEqual(reads, [undefined]);
  });

  it("takes a complete widened page over a cut-short scoped one", async () => {
    reads.length = 0;
    const elsewhere = hit({ label: "Evidence", id: "e1", sessionId: "session-other" });
    const result = await resolveCitation(evidence, "session-report", paging([
      { truncated: true },
      { hits: [elsewhere] },
    ]));
    assert.deepEqual(result, { hit: elsewhere, status: "ready" });
  });

  it("does not accept a DbRecord the same id names in another Session", async () => {
    reads.length = 0;
    const foreign = hit({
      label: "DbRecord",
      id: "10.1021/jacs.6b00001",
      sessionId: "session-foreign",
      extra: { identifier: "10.1021/jacs.6b00001", title: "A record from another Session" },
    });
    const result = await resolveCitation(
      { id: foreign.id, kind: "dbrecord", label: "dbrecord1" },
      "session-report",
      paging([{}, { hits: [foreign] }]),
    );
    assert.deepEqual(result, { status: "unlocated" }, "a same-id record of another Session is not the cited one");
    assert.deepEqual(reads, ["session-report"], "a shared id is not widened at all");
  });

  it("still reads a DbRecord citation by the Session it names", async () => {
    reads.length = 0;
    const record = hit({
      label: "DbRecord",
      id: "10.1021/jacs.6b00001",
      sessionId: "session-other",
      extra: { identifier: "10.1021/jacs.6b00001", title: "The cited record" },
    });
    const result = await resolveCitation(
      { id: record.id, kind: "dbrecord", label: "dbrecord1", sessionId: "session-other" },
      "session-report",
      paging([{ hits: [record] }]),
    );
    assert.deepEqual(result, { hit: record, status: "ready" });
    assert.deepEqual(reads, ["session-other"]);
  });
});
