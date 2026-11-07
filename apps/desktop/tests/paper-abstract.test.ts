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

import assert from "node:assert/strict";

import { createTest } from "../../../test/support/tagged/compat.mjs";
import { decodeEntities, paperAbstractParagraphs } from "../src/app/paper-abstract.js";

const { describe, it } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

describe("paperAbstractParagraphs", () => {
  it("reads a Europe PMC abstract out of its section markup", () => {
    const raw = "<h4>Background/purpose</h4><p>Nickel catalysts matter.</p>"
      + "<h4>Methods</h4><p>We ran a fixed-bed reactor at 350 °C.</p>"
      + "<h4>Results</h4><p>Conversion rose with temperature.</p>";

    assert.deepEqual(paperAbstractParagraphs(raw), [
      "Nickel catalysts matter.",
      "We ran a fixed-bed reactor at 350 °C.",
      "Conversion rose with temperature.",
    ]);
  });

  it("keeps prose that precedes the first heading", () => {
    assert.deepEqual(
      paperAbstractParagraphs("Methane conversion over nickel. <h4>Methods</h4><p>Reactors.</p>"),
      ["Methane conversion over nickel.", "Reactors."],
    );
  });

  it("returns plain prose unchanged, as one paragraph", () => {
    assert.deepEqual(
      paperAbstractParagraphs("Methane conversion over a nickel catalyst rises with temperature up to 350 °C."),
      ["Methane conversion over a nickel catalyst rises with temperature up to 350 °C."],
    );
  });

  it("drops inline markup and separates paragraphs", () => {
    const raw = "<p>Alpha <b>beta</b> &amp; gamma.</p><p>Delta.</p>";

    assert.deepEqual(paperAbstractParagraphs(raw), ["Alpha beta & gamma.", "Delta."]);
  });

  it("treats a line break as a paragraph break", () => {
    assert.deepEqual(paperAbstractParagraphs("One<br/>Two"), ["One", "Two"]);
  });

  it("has nothing to say about an empty abstract", () => {
    assert.deepEqual(paperAbstractParagraphs("   "), []);
    assert.deepEqual(paperAbstractParagraphs("<h4>Methods</h4>"), []);
    assert.deepEqual(paperAbstractParagraphs("<p></p>"), []);
  });

  it("never leaves a tag or a section label on screen", () => {
    const raw = "<h4>Methods</h4><p>We used <i>in situ</i> XRD<br/>and GC-MS.</p>";

    assert.deepEqual(paperAbstractParagraphs(raw), ["We used in situ XRD", "and GC-MS."]);
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric references", () => {
    assert.equal(decodeEntities("a &lt; b &amp; &#176;C &#x3b1;"), "a < b & °C α");
  });

  it("leaves an unknown reference as written", () => {
    assert.equal(decodeEntities("5 &euro; &bogus;"), "5 &euro; &bogus;");
  });

  it("does not re-decode a double-escaped reference", () => {
    assert.equal(decodeEntities("&amp;lt;"), "&lt;");
  });

  it("leaves an out-of-range reference as written", () => {
    assert.equal(decodeEntities("&#x110000; &#0;"), "&#x110000; &#0;");
  });
});
