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

/**
 * Character references are decoded in one pass: each reference in the *source*
 * is consumed once, and the text produced by a reference is never scanned again.
 * The distinction is observable on a page that escaped its own markup, where
 * `&amp;lt;` must stay the two characters `&lt;` rather than becoming `<`.
 */

import { createTest } from "../../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { decodeEntities, textOf } from "./html.js";
import { NAMED_ENTITIES } from "./html-named-entities.js";

test("decodes each character reference once instead of rescanning its output", () => {
  assert.equal(decodeEntities("&amp;lt;"), "&lt;");
  assert.equal(decodeEntities("&amp;gt;"), "&gt;");
  assert.equal(decodeEntities("&amp;amp;"), "&amp;");
  assert.equal(decodeEntities("&amp;quot;"), "&quot;");
  assert.equal(decodeEntities("&amp;#65;"), "&#65;");
  assert.equal(decodeEntities("&amp;#x41;"), "&#x41;");
  assert.equal(textOf("Use &amp;lt;b&amp;gt; carefully"), "Use &lt;b&gt; carefully");
});

test("decodes named, decimal and hexadecimal references in that same single pass", () => {
  assert.equal(decodeEntities("a &amp; b"), "a & b");
  assert.equal(decodeEntities("a &lt; b &gt; c"), "a < b > c");
  assert.equal(decodeEntities("&quot;&nbsp;end"), "\" end");
  assert.equal(decodeEntities("&#65;&#x41;"), "AA");
  assert.equal(decodeEntities("it&#39;s"), "it's");
  assert.equal(decodeEntities("&#X27;"), "'");
  assert.equal(decodeEntities("&#x27;"), "'");
});

test("leaves surrogate and non-character scalars as literal text", () => {
  // A lone surrogate cannot be encoded as UTF-8 or carried in JSON output.
  for (const reference of ["&#55296;", "&#xDFFF;", "&#57343;"]) {
    const decoded = decodeEntities(reference);
    assert.equal(decoded, reference);
    assert.equal([...decoded].some((character) => character >= "\uD800" && character <= "\uDFFF"), false);
  }
  // Non-characters are not interchanged, so they stay as written too.
  assert.equal(decodeEntities("&#65534;"), "&#65534;");
  assert.equal(decodeEntities("&#65535;"), "&#65535;");
  assert.equal(decodeEntities("&#xFFFF;"), "&#xFFFF;");
});

test("leaves references it does not know, and out-of-range scalars, untouched", () => {
  assert.equal(decodeEntities("&bogus;"), "&bogus;");
  assert.equal(decodeEntities("&#0;"), "&#0;");
  assert.equal(decodeEntities("&#1114112;"), "&#1114112;");
  assert.equal(decodeEntities("bare & ampersand"), "bare & ampersand");
});

test("decodes the typographic, Latin-1 and maths names the table carries", () => {
  const named: ReadonlyArray<readonly [string, string]> = [
    ["&mdash;", "\u2014"],
    ["&ndash;", "\u2013"],
    ["&hellip;", "\u2026"],
    ["&rsquo;", "\u2019"],
    ["&lsquo;", "\u2018"],
    ["&ldquo;", "\u201C"],
    ["&rdquo;", "\u201D"],
    ["&eacute;", "\u00E9"],
    ["&egrave;", "\u00E8"],
    ["&ouml;", "\u00F6"],
    ["&apos;", "'"],
    ["&middot;", "\u00B7"],
    ["&times;", "\u00D7"],
    ["&deg;", "\u00B0"],
    ["&plusmn;", "\u00B1"],
  ];
  for (const [reference, expected] of named) assert.equal(decodeEntities(reference), expected, reference);

  // The shape the free engines actually hand over: a European title and a range.
  assert.equal(
    textOf("Caf&eacute; culture &mdash; 5&ndash;10 &hellip; O&apos;Brien"),
    "Café culture — 5–10 … O'Brien",
  );
});

test("keeps a name outside the table, and a reference without its semicolon, literal", () => {
  // Not carried: the bounded table is documented, so an unlisted name is still text.
  assert.equal(decodeEntities("&diams;"), "&diams;");
  // A semicolon is what ends a reference; without it the ampersand is plain text.
  assert.equal(decodeEntities("&amp"), "&amp");
  assert.equal(decodeEntities("&mdash"), "&mdash");
});

test("states every table entry exactly once, one scalar each", () => {
  // The table is written as text, so a malformed pair would silently shrink it;
  // pin the size and the shape every entry has to end up with.
  assert.equal(NAMED_ENTITIES.size, 131);
  for (const [name, value] of NAMED_ENTITIES) {
    assert.match(name, /^[A-Za-z][A-Za-z0-9]*$/, name);
    assert.equal([...value].length, 1, name);
  }
  assert.equal(NAMED_ENTITIES.get("amp"), "&");
  assert.equal(NAMED_ENTITIES.get("nbsp"), " ");
  assert.equal(NAMED_ENTITIES.get("euro"), "\u20AC");
  assert.equal(NAMED_ENTITIES.get("prod"), "\u220F");
});
