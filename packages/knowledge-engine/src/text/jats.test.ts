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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { jatsToMarkdown, parseXml } from "./jats.js";

void test("parseXml parses nested elements with attributes and entities", () => {
  const root = parseXml(`<a x="1&amp;2"><b>hello</b> world <c/></a>`);
  assert.equal(root?.tag, "a");
  assert.equal(root?.attrs["x"], "1&2");
  assert.equal(root?.children.length, 3);
});

void test("jatsToMarkdown renders title, abstract, sections and formulas", () => {
  const jats = `<?xml version="1.0"?>
  <article>
    <front><article-meta>
      <title-group><article-title>Neutralizing antibodies against <i>Ebola virus</i> GP</article-title></title-group>
      <abstract><p>We isolated mAb114 from a survivor.</p></abstract>
    </article-meta></front>
    <body>
      <sec>
        <title>Results</title>
        <p>mAb114 binds the glycoprotein core <xref ref-type="bibr" rid="R7">[7]</xref>.</p>
        <sec>
          <title>Binding kinetics</title>
          <p>Affinity was measured by SPR.</p>
          <disp-formula><tex-math>K_d = 1.2 \\times 10^{-9} M</tex-math></disp-formula>
        </sec>
      </sec>
      <sec>
        <title>Methods</title>
        <p>Inline math <inline-formula><tex-math>IC_{50}</tex-math></inline-formula> was computed.</p>
      </sec>
    </body>
    <back><ref-list>
      <ref id="R7"><mixed-citation>Smith et al. Nature 2024</mixed-citation></ref>
    </ref-list></back>
  </article>`;
  const result = jatsToMarkdown(jats);
  assert.equal(result.title, "Neutralizing antibodies against *Ebola virus* GP");
  assert.match(result.markdown, /^# Neutralizing antibodies against \*Ebola virus\* GP/);
  assert.match(result.markdown, /## Abstract\n\nWe isolated mAb114 from a survivor\./);
  assert.match(result.markdown, /## Results/);
  assert.match(result.markdown, /### Binding kinetics/);
  // Bibliography xref becomes the [@key] anchor convention.
  assert.match(result.markdown, /glycoprotein core \[@R7\]\./);
  assert.match(result.markdown, /\$\$\nK_d = 1\.2 \\times 10\^\{-9\} M\n\$\$/);
  assert.match(result.markdown, /\$IC_\{50\}\$/);
  assert.match(result.markdown, /## References\n\n- \[R7\] Smith et al\. Nature 2024/);
  assert.equal(result.referenceCount, 1);
});

void test("jatsToMarkdown flattens tables and figure captions", () => {
  const jats = `<article><body>
    <sec><title>Data</title>
      <table-wrap><label>Table 1</label><caption><p>Antibody panel</p></caption>
        <table><thead><tr><th>Name</th><th>IC50</th></tr></thead>
        <tbody><tr><td>mAb114</td><td>0.1</td></tr></tbody></table>
      </table-wrap>
      <fig><caption><p>Structure of GP complex.</p></caption></fig>
    </sec>
  </body></article>`;
  const result = jatsToMarkdown(jats);
  assert.match(result.markdown, /\[Table 1\] Antibody panel/);
  assert.match(result.markdown, /\| Name \| IC50 \|/);
  assert.match(result.markdown, /\| mAb114 \| 0\.1 \|/);
  assert.match(result.markdown, /\[Figure\] Structure of GP complex\./);
});

void test("jatsToMarkdown returns empty for non-article input", () => {
  assert.deepEqual(jatsToMarkdown("<html><body>x</body></html>"), { markdown: "", title: null, referenceCount: 0 });
  assert.deepEqual(jatsToMarkdown("not xml at all"), { markdown: "", title: null, referenceCount: 0 });
});

void test("jatsToMarkdown handles CDATA and numeric entities", () => {
  const jats = `<article><body><sec><title>S</title><p><![CDATA[a < b]]> and &#945;-helix</p></sec></body></article>`;
  const result = jatsToMarkdown(jats);
  assert.match(result.markdown, /a < b and α-helix/);
});
