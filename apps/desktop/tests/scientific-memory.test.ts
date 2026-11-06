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
