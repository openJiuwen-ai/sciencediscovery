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

import { decodeEntities, decodeTable, textOf, NAMED_ENTITIES } from "./html.js";

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

test("decodes the named references a browser renders in result titles and snippets", () => {
  const named: ReadonlyArray<readonly [string, string]> = [
    // Latin-1 accents: a European title or author name.
    ["&eacute;", "\u00E9"],
    ["&egrave;", "\u00E8"],
    ["&ouml;", "\u00F6"],
    ["&ntilde;", "\u00F1"],
    ["&apos;", "'"],
    // Typographic punctuation: dashes, ellipsis and curly quotes.
    ["&mdash;", "\u2014"],
    ["&ndash;", "\u2013"],
    ["&hellip;", "\u2026"],
    ["&lsquo;", "\u2018"],
    ["&rsquo;", "\u2019"],
    ["&ldquo;", "\u201C"],
    ["&rdquo;", "\u201D"],
    // Symbols the older sources a science search hits emit.
    ["&diams;", "\u2666"],
    ["&middot;", "\u00B7"],
    ["&times;", "\u00D7"],
    ["&deg;", "\u00B0"],
    ["&plusmn;", "\u00B1"],
    ["&copy;", "\u00A9"],
    ["&reg;", "\u00AE"],
    ["&euro;", "\u20AC"],
  ];
  for (const [reference, expected] of named) assert.equal(decodeEntities(reference), expected, reference);

  // The case from the report: the extraction the free engines hand to the model
  // and the report, not just a bare reference.
  assert.equal(
    textOf("Caf&eacute; culture &mdash; 5&ndash;10 &hellip; O&apos;Brien"),
    "Caf\u00E9 culture \u2014 5\u201310 \u2026 O'Brien",
  );
  // Greek and maths notation a paper abstract carries.
  assert.equal(textOf("&mu;m and &Omega; &le; 10 &asymp; &pi;"), "\u03BCm and \u03A9 \u2264 10 \u2248 \u03C0");
});

test("matches a reference name case-sensitively, not by folding it", () => {
  // Both spellings are names in their own right, with distinct characters.
  assert.equal(decodeEntities("&Eacute; &eacute;"), "\u00C9 \u00E9");
  assert.equal(decodeEntities("&Uuml; &uuml;"), "\u00DC \u00FC");
  // A spelling outside this bounded table stays literal rather than being
  // folded onto a name the table does carry. The HTML Standard also defines
  // uppercase AMP/LT/GT/QUOT/COPY/REG and 2125 `;`-terminated names (2231 named
  // references in total); this table is deliberately narrower, so an absent
  // spelling is text, not a fold.
  assert.equal(decodeEntities("&MDASH; &Mdash;"), "&MDASH; &Mdash;");
  assert.equal(decodeEntities("&Amp; &Diams;"), "&Amp; &Diams;");
});

test("decodes named references once, and only when a semicolon terminates them", () => {
  // The single-pass guard from #672 still holds for the widened table: the
  // replacement is never rescanned, so escaping survives one decode.
  assert.equal(decodeEntities("&amp;mdash;"), "&mdash;");
  assert.equal(decodeEntities("&amp;eacute;"), "&eacute;");
  assert.equal(decodeEntities("&amp;diams;"), "&diams;");
  assert.equal(decodeEntities("&amp;lt;b&amp;gt;"), "&lt;b&gt;");
  assert.equal(textOf("Caf&eacute; &amp;mdash; 5&ndash;10"), "Caf\u00E9 &mdash; 5\u201310");
  // Without the terminator the ampersand is plain text, for the new names too.
  assert.equal(decodeEntities("&mdash"), "&mdash");
  assert.equal(decodeEntities("&eacute"), "&eacute");
  assert.equal(decodeEntities("&bogus;"), "&bogus;");
});

test("numeric references keep decoding to their scalar, including astral planes", () => {
  assert.equal(decodeEntities("&#65; &#x41; &#x1F600;"), "A A \u{1F600}");
});

test("rejects a malformed, out-of-range, undecodable or repeated table entry", () => {
  // The loader runs once at import, so these guards would otherwise surface only
  // as a wrong character in production text. Each case is the mistake it names.
  const rejected: ReadonlyArray<readonly [string, RegExp]> = [
    ["eacute:e9x", /malformed named reference code point/],
    ["eacute:E9", /malformed named reference code point/],
    ["eacute:", /malformed named reference code point/],
    ["eacute", /malformed named reference entry/],
    ["eacute:0", /not a decodable scalar/],
    ["eacute:1fffff", /not a decodable scalar/],
    ["eacute:110000", /not a decodable scalar/],
    ["eacute:d800", /not a decodable scalar/],
    ["eacute:ffff", /not a decodable scalar/],
  ];
  for (const [pair, expected] of rejected) assert.throws(() => decodeTable([pair]), expected, pair);
  // A repeated spelling is a mistake, not a last-wins update.
  assert.throws(() => decodeTable(["amp:26", "lt:3c amp:26"]), /duplicate named reference: "amp"/);
  // The same text without the mistake loads, so the cases above fail on the
  // content and not on the helper.
  assert.equal(decodeTable(["amp:26 lt:3c"]).size, 2);
});

test("states every table entry exactly once, one scalar each", () => {
  // `decodeTable` rejects a malformed pair, an out-of-range code point and a
  // repeated name at load; what it cannot notice is a name silently missing
  // from the blob, so pin the size as well as the shape of every entry.
  assert.equal(NAMED_ENTITIES.size, 252);
  for (const [name, value] of NAMED_ENTITIES) {
    assert.match(name, /^[A-Za-z][A-Za-z0-9]*$/, name);
    assert.equal([...value].length, 1, name);
    assert.notEqual(value, "\u00A0", `${name} must not decode to a non-breaking space`);
  }
  assert.equal(NAMED_ENTITIES.get("amp"), "&");
  // `nbsp` is the one deliberate deviation: existing callers expect a space.
  assert.equal(NAMED_ENTITIES.get("nbsp"), " ");
  assert.equal(NAMED_ENTITIES.get("diams"), "\u2666");
  assert.equal(NAMED_ENTITIES.get("euro"), "\u20AC");
  assert.equal(NAMED_ENTITIES.get("prod"), "\u220F");
});
