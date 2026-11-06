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
  buildChipIndex,
  graphChipNodes,
  graphChipUrl,
  parseGraphChipUrl,
  referenceNodeLabel,
  referencesByUrl,
  remarkGraphChips,
  type ChipNode,
} from "../src/app/memory-chips.js";
import type { ComposerReference } from "../src/api/types.js";

const evidence: ComposerReference = { id: "evidence-1", kind: "evidence", label: "evidence1" };
const artifact: ComposerReference = { id: "artifact-1", kind: "artifact", label: "artifact1", version: 2 };

describe("the alias index", () => {
  it("maps both the label and the id, without letting an id shadow a label", () => {
    const index = buildChipIndex([evidence, artifact]);
    assert.equal(index.get("evidence1"), evidence);
    assert.equal(index.get("evidence-1"), evidence);
    assert.equal(index.get("artifact1"), artifact);
  });

  it("survives a report that carries no references", () => {
    assert.equal(buildChipIndex(undefined).size, 0);
  });
});

describe("the chip URL", () => {
  it("round-trips a kind and an id", () => {
    const url = graphChipUrl(evidence);
    assert.equal(url, "graph://evidence/evidence-1");
    assert.deepEqual(parseGraphChipUrl(url), { id: "evidence-1", kind: "evidence" });
  });

  it("carries the version a citation pins", () => {
    const url = graphChipUrl(artifact);
    assert.equal(url, "graph://artifact/artifact-1?v=2");
    assert.deepEqual(parseGraphChipUrl(url), { id: "artifact-1", kind: "artifact", version: 2 });
  });

  it("escapes an id that would otherwise break the URL", () => {
    const url = graphChipUrl({ id: "artifact/1 #v2", kind: "artifact" });
    assert.deepEqual(parseGraphChipUrl(url), { id: "artifact/1 #v2", kind: "artifact" });
  });

  it("ignores anything that is not a chip URL", () => {
    assert.equal(parseGraphChipUrl("https://example.test/a"), undefined);
    assert.equal(parseGraphChipUrl("graph://artifact/%E0%A4%A"), undefined, "a malformed escape is text");
  });

  it("maps back to the reference that knows its version", () => {
    const byUrl = referencesByUrl([evidence, artifact]);
    assert.equal(byUrl.get(graphChipUrl(artifact)), artifact);
    assert.equal(byUrl.get(graphChipUrl(artifact))?.version, 2);
  });

  it("keeps two versions of one artifact apart", () => {
    // The same artifact cited twice, at two versions. Both chips name
    // `artifact-1`; only the URL's version says which document to open.
    const first: ComposerReference = { id: "artifact-1", kind: "artifact", label: "artifact1", version: 1 };
    const second: ComposerReference = { id: "artifact-1", kind: "artifact", label: "artifact2", version: 3 };
    const byUrl = referencesByUrl([first, second]);
    assert.equal(byUrl.get(graphChipUrl(first)), first);
    assert.equal(byUrl.get(graphChipUrl(second)), second);

    const nodes = graphChipNodes("First [artifact1], then [artifact2].", buildChipIndex([first, second]));
    assert.deepEqual(
      nodes?.filter((node) => node.type === "link").map((node) => node.url),
      ["graph://artifact/artifact-1?v=1", "graph://artifact/artifact-1?v=3"],
    );
  });
});

describe("which graph label a kind reaches", () => {
  it("maps the four citable node kinds", () => {
    assert.equal(referenceNodeLabel("evidence"), "Evidence");
    assert.equal(referenceNodeLabel("artifact"), "Artifact");
    assert.equal(referenceNodeLabel("sourcefile"), "SourceFile");
    assert.equal(referenceNodeLabel("dbrecord"), "DbRecord");
  });

  it("leaves composer-only context alone", () => {
    assert.equal(referenceNodeLabel("session"), undefined);
    assert.equal(referenceNodeLabel("skill"), undefined);
  });
});

describe("rewriting a line of prose", () => {
  const index = buildChipIndex([evidence, artifact]);

  it("turns a resolvable alias into a link and keeps the surrounding text", () => {
    const nodes = graphChipNodes("As shown [evidence1], the rate rose.", index);
    assert.deepEqual(nodes, [
      { type: "text", value: "As shown " },
      { children: [{ type: "text", value: "[evidence1]" }], type: "link", url: "graph://evidence/evidence-1" },
      { type: "text", value: ", the rate rose." },
    ]);
  });

  it("leaves an alias the report did not register as plain text", () => {
    assert.equal(graphChipNodes("A literal [note] stays put.", index), undefined);
  });

  it("does nothing when there are no references at all", () => {
    assert.equal(graphChipNodes("[evidence1]", new Map()), undefined);
  });

  it("links every occurrence", () => {
    const nodes = graphChipNodes("[evidence1] then [artifact1]", index);
    assert.deepEqual(
      nodes?.filter((node) => node.type === "link").map((node) => node.url),
      ["graph://evidence/evidence-1", "graph://artifact/artifact-1?v=2"],
    );
  });
});

describe("the remark transform", () => {
  const index = buildChipIndex([evidence]);

  it("rewrites text inside a paragraph and leaves links alone", () => {
    const tree: ChipNode = {
      children: [
        { children: [{ type: "text", value: "See [evidence1]." }], type: "paragraph" },
        { children: [{ type: "text", value: "[evidence1]" }], type: "link", url: "https://example.test" },
      ],
      type: "root",
    };

    remarkGraphChips({ index })(tree);

    const paragraph = tree.children?.[0];
    assert.deepEqual(paragraph?.children?.map((node) => node.type), ["text", "link", "text"]);
    const link = tree.children?.[1];
    assert.equal(link?.url, "https://example.test", "an existing link is not re-read as prose");
  });

  it("leaves a tree with no citations untouched", () => {
    const tree: ChipNode = {
      children: [{ children: [{ type: "text", value: "No citations here." }], type: "paragraph" }],
      type: "root",
    };
    remarkGraphChips({ index })(tree);
    assert.deepEqual(tree.children?.[0]?.children, [{ type: "text", value: "No citations here." }]);
  });
});
