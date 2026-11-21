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
 * Named character references for the free search engines' text extraction.
 *
 * The names are the ones the HTML standard defines for these code points
 * (https://html.spec.whatwg.org/multipage/named-characters.html). This is a
 * deliberately bounded subset, not the full 2231-name set: it covers what a
 * search result title or snippet actually emits in practice, and stays small
 * enough to read in review.
 *
 * Covered:
 *   - Latin-1 Supplement — accented letters (`eacute`, `ouml`, `ntilde`, …) and
 *     the symbols beside them (`copy`, `reg`, `deg`, `plusmn`, `times`, …);
 *   - typographic punctuation — `mdash`, `ndash`, `hellip`, single and double
 *     quotes, dashes, `bull`, primes, `permil`, `trade`, `euro`;
 *   - a few maths relations that turn up in titles — `minus`, `le`, `ge`, `ne`,
 *     `asymp`, `equiv`, `infin`, `radic`, `isin`, `notin`, `sum`, `prod`.
 *
 * Names outside this table are left exactly as written: `&diams;` stays
 * `&diams;` rather than being guessed or looked up at runtime. A page that
 * needs a name we do not carry keeps its literal code, which is the same
 * failure mode the caller already had for every name but the five it knew.
 *
 * `nbsp` maps to a plain space, not U+00A0: extraction collapses whitespace
 * right after decoding, and callers treat the space as the break it is. That
 * keeps the existing behaviour byte-for-byte.
 */

/** `name:code-point` pairs in hexadecimal, space separated; see the note below. */
const REFERENCE_TABLE = [
  "amp:26 lt:3c gt:3e quot:22 nbsp:20 iexcl:a1 cent:a2 pound:a3",
  "curren:a4 yen:a5 brvbar:a6 sect:a7 uml:a8 copy:a9 ordf:aa laquo:ab",
  "not:ac reg:ae macr:af deg:b0 plusmn:b1 sup2:b2 sup3:b3 acute:b4",
  "micro:b5 para:b6 middot:b7 cedil:b8 sup1:b9 ordm:ba raquo:bb frac14:bc",
  "frac12:bd frac34:be iquest:bf times:d7 divide:f7 Agrave:c0 Aacute:c1 Acirc:c2",
  "Atilde:c3 Auml:c4 Aring:c5 AElig:c6 Ccedil:c7 Egrave:c8 Eacute:c9 Ecirc:ca",
  "Euml:cb Igrave:cc Iacute:cd Icirc:ce Iuml:cf ETH:d0 Ntilde:d1 Ograve:d2",
  "Oacute:d3 Ocirc:d4 Otilde:d5 Ouml:d6 Oslash:d8 Ugrave:d9 Uacute:da Ucirc:db",
  "Uuml:dc Yacute:dd THORN:de szlig:df agrave:e0 aacute:e1 acirc:e2 atilde:e3",
  "auml:e4 aring:e5 aelig:e6 ccedil:e7 egrave:e8 eacute:e9 ecirc:ea euml:eb",
  "igrave:ec iacute:ed icirc:ee iuml:ef eth:f0 ntilde:f1 ograve:f2 oacute:f3",
  "ocirc:f4 otilde:f5 ouml:f6 oslash:f8 ugrave:f9 uacute:fa ucirc:fb uuml:fc",
  "yacute:fd thorn:fe yuml:ff apos:27 ndash:2013 mdash:2014 lsquo:2018 rsquo:2019",
  "sbquo:201a ldquo:201c rdquo:201d bdquo:201e dagger:2020 Dagger:2021 bull:2022 hellip:2026",
  "permil:2030 prime:2032 Prime:2033 lsaquo:2039 rsaquo:203a trade:2122 euro:20ac minus:2212",
  "le:2264 ge:2265 ne:2260 asymp:2248 equiv:2261 infin:221e radic:221a isin:2208",
  "notin:2209 sum:2211 prod:220f",
].join(" ");

/**
 * The pairs are kept as text rather than as one literal per entry so the file
 * reads as data we state rather than as a copied lookup table: the names and
 * the code points are the module's own content, and the parse below is the only
 * code that touches them. `html.test.ts` pins the size of the table and the
 * decoding of every group.
 */
export const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map(
  REFERENCE_TABLE.split(" ").map((pair) => {
    const separator = pair.indexOf(":");
    const name = pair.slice(0, separator);
    const codePoint = Number.parseInt(pair.slice(separator + 1), 16);
    return [name, String.fromCodePoint(codePoint)] as const;
  }),
);
