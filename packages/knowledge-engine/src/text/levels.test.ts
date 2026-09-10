// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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

import assert from "node:assert/strict";
import test from "node:test";

import { jatsToMarkdown } from "./jats.js";
import { buildDeterministicL0, documentAnchor, parseDocumentBlocks, resolveDocumentAnchor } from "./levels.js";

const JATS_SAMPLE = `<?xml version="1.0"?>
<article>
  <front>
    <article-meta>
      <title-group><article-title>Neutralization of Ebola virus</article-title></title-group>
      <abstract><p>Ebola virus causes severe disease. We report neutralizing antibodies.</p></abstract>
    </article-meta>
  </front>
  <body>
    <sec><title>Introduction</title>
      <p>Ebola virus remains a public health concern. Outbreaks have high mortality.</p>
      <p>Prior antibodies showed partial protection [@b1].</p>
    </sec>
    <sec><title>Results</title>
      <p>The GP protein binds the receptor.</p>
      <disp-formula><tex-math>K_d = 4.2\\,\\mathrm{nM}</tex-math></disp-formula>
      <fig><caption>Structure of the GP trimer complex</caption></fig>
      <table-wrap><label>Table 1</label><caption>Neutralization IC50</caption>
        <table><thead><tr><th>Antibody</th><th>IC50</th></tr></thead>
        <tbody><tr><td>mAb114</td><td>0.2</td></tr></tbody></table>
      </table-wrap>
    </sec>
  </body>
  <back><ref-list>
    <ref id="b1"><citation>Bornholdt 2016 Cell</citation></ref>
    <ref id="b2"><citation>Wec 2017 Nat Microbiol</citation></ref>
  </ref-list></back>
</article>`;

test("parseDocumentBlocks types every jats.ts construct and numbers types independently", () => {
  const { markdown } = jatsToMarkdown(JATS_SAMPLE);
  const blocks = parseDocumentBlocks(markdown);

  const heading = blocks.find((block) => block.type === "heading" && block.text === "Introduction");
  const paragraph = blocks.find((block) => block.type === "paragraph" && block.text.includes("public health concern"));
  const formula = blocks.find((block) => block.type === "formula");
  const figure = blocks.find((block) => block.type === "figure");
  const table = blocks.find((block) => block.type === "table");
  const references = blocks.filter((block) => block.type === "reference");

  assert.ok(heading, "heading block");
  assert.ok(paragraph, "paragraph block");
  assert.ok(formula, "formula block");
  assert.ok(figure, "figure block");
  assert.ok(table, "table block");
  assert.equal(references.length, 2, "one reference block per bibliography entry");

  // Per-type indices are sequential and independent (5 headings: title,
  // Abstract, Introduction, Results, References).
  assert.equal(blocks.filter((block) => block.type === "heading").map((block) => block.index).join(","), "0,1,2,3,4");
  assert.equal(blocks.filter((block) => block.type === "paragraph").map((block) => block.index).join(","), "0,1,2,3");
  assert.equal(formula!.index, 0);
  assert.equal(table!.index, 0);
  assert.ok(table!.text.startsWith("[Table 1]"), "table block absorbs its caption line");
  assert.deepEqual(references.map((block) => block.index), [0, 1]);

  // Section tracking: paragraphs carry their nearest heading; references sit under References.
  assert.equal(paragraph!.section, "Introduction");
  assert.equal(formula!.section, "Results");
  assert.equal(references[0]!.section, "References");
  // The title itself is a heading block with null section (no preceding heading).
  const titleBlock = blocks.find((block) => block.type === "heading" && block.text === "Neutralization of Ebola virus");
  assert.equal(titleBlock!.section, "Neutralization of Ebola virus");
});

test("parseDocumentBlocks is deterministic — identical input, identical output", () => {
  const { markdown } = jatsToMarkdown(JATS_SAMPLE);
  assert.deepEqual(parseDocumentBlocks(markdown), parseDocumentBlocks(markdown));
});

test("parseDocumentBlocks reports 1-based lineStart for every block", () => {
  const markdown = ["# Title", "", "First paragraph.", "", "Second paragraph."].join("\n");
  const blocks = parseDocumentBlocks(markdown);
  assert.equal(blocks[0]!.lineStart, 1);
  assert.equal(blocks[1]!.lineStart, 3);
  assert.equal(blocks[2]!.lineStart, 5);
});

test("parseDocumentBlocks merges wrapped pdfplumber lines into one paragraph", () => {
  const markdown = "This is a long sentence that pdfplumber\nwrapped across several physical\nlines in the text layer.";
  const blocks = parseDocumentBlocks(markdown);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, "paragraph");
  assert.equal(blocks[0]!.text, "This is a long sentence that pdfplumber wrapped across several physical lines in the text layer.");
});

test("parseDocumentBlocks survives malformed input without throwing", () => {
  assert.deepEqual(parseDocumentBlocks(""), []);
  // Unterminated formula fence: the remainder becomes one formula block.
  const unterminated = parseDocumentBlocks("Text.\n\n$$\nK_d = x");
  assert.ok(unterminated.some((block) => block.type === "formula"));
  // Unterminated code fence likewise.
  const openCode = parseDocumentBlocks("```\nlet x = 1;");
  assert.ok(openCode.some((block) => block.type === "code"));
});

test("preview is whitespace-normalized and capped", () => {
  const blocks = parseDocumentBlocks(`${"word ".repeat(60)}`);
  assert.ok(blocks[0]!.preview.length <= 160);
  assert.ok(blocks[0]!.preview.endsWith("…"));
});

test("documentAnchor follows the {docId}:{type}:{index} DA convention", () => {
  assert.equal(documentAnchor("doc-1", { type: "paragraph", index: 3 }), "doc-1:paragraph:3");
});

test("resolveDocumentAnchor round-trips anchors and returns neighbors", () => {
  const { markdown } = jatsToMarkdown(JATS_SAMPLE);
  const blocks = parseDocumentBlocks(markdown);
  const paragraph = blocks.find((block) => block.type === "paragraph" && block.text.includes("partial protection"))!;
  const anchorId = documentAnchor("kb1-doc1", paragraph);
  const hit = resolveDocumentAnchor(blocks, anchorId);
  assert.ok(hit);
  assert.equal(hit!.block.text, paragraph.text);
  assert.ok(hit!.before || hit!.after, "paragraph has neighbors in this document");

  assert.equal(resolveDocumentAnchor(blocks, "kb1-doc1:paragraph:999"), null);
  assert.equal(resolveDocumentAnchor(blocks, "not-an-anchor"), null);
  assert.equal(resolveDocumentAnchor(blocks, "doc:paragraph:-1"), null);
});

test("buildDeterministicL0 prefers the abstract column, then body, then title", () => {
  const { markdown } = jatsToMarkdown(JATS_SAMPLE);
  const blocks = parseDocumentBlocks(markdown);

  const fromAbstract = buildDeterministicL0({ title: "T", abstract: "Stored abstract wins.", blocks });
  assert.equal(fromAbstract.source, "abstract");
  assert.equal(fromAbstract.summary, "Stored abstract wins.");

  const bodyBlocks = parseDocumentBlocks(
    "## Methods\n\nThis paragraph is deliberately long enough to exceed the one hundred twenty character threshold for body extraction so that the L0 builder selects it as the summary source from the document body.",
  );
  const fromBody = buildDeterministicL0({ title: "T", abstract: null, blocks: bodyBlocks });
  assert.equal(fromBody.source, "body");
  assert.ok(fromBody.summary.length > 0);

  const fromTitle = buildDeterministicL0({ title: "Only a title", abstract: "", blocks: [] });
  assert.equal(fromTitle.source, "title");
  assert.equal(fromTitle.summary, "Only a title");
});

test("buildDeterministicL0 tags come from headings, excluding Abstract/References, capped", () => {
  const { markdown } = jatsToMarkdown(JATS_SAMPLE);
  const blocks = parseDocumentBlocks(markdown);
  const l0 = buildDeterministicL0({ title: "T", abstract: "a", blocks });
  assert.deepEqual(l0.tags, ["Neutralization of Ebola virus", "Introduction", "Results"]);

  const many = parseDocumentBlocks(
    ["Intro", "Methods", "Results", "Discussion", "Conclusion", "Extra"].map((t) => `## ${t}\n\nParagraph text here.`).join("\n\n"),
  );
  assert.equal(buildDeterministicL0({ title: "T", abstract: "a", blocks: many }).tags.length, 5);
});

test("buildDeterministicL0 clamps long summaries at a sentence boundary", () => {
  const long = "First sentence ends here. ".repeat(30);
  const l0 = buildDeterministicL0({ title: "T", abstract: long, blocks: [] });
  assert.ok(l0.summary.length <= 320);
  assert.ok(l0.summary.endsWith("."));
});
