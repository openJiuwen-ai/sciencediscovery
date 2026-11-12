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
 * The names come from the WHATWG HTML named character references table
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
export const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  // The five the extractor already carried; every caller depends on them.
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  // Latin-1 Supplement symbols.
  ["nbsp", " "],
  ["iexcl", "\u00A1"],
  ["cent", "\u00A2"],
  ["pound", "\u00A3"],
  ["curren", "\u00A4"],
  ["yen", "\u00A5"],
  ["brvbar", "\u00A6"],
  ["sect", "\u00A7"],
  ["uml", "\u00A8"],
  ["copy", "\u00A9"],
  ["ordf", "\u00AA"],
  ["laquo", "\u00AB"],
  ["not", "\u00AC"],
  ["reg", "\u00AE"],
  ["macr", "\u00AF"],
  ["deg", "\u00B0"],
  ["plusmn", "\u00B1"],
  ["sup2", "\u00B2"],
  ["sup3", "\u00B3"],
  ["acute", "\u00B4"],
  ["micro", "\u00B5"],
  ["para", "\u00B6"],
  ["middot", "\u00B7"],
  ["cedil", "\u00B8"],
  ["sup1", "\u00B9"],
  ["ordm", "\u00BA"],
  ["raquo", "\u00BB"],
  ["frac14", "\u00BC"],
  ["frac12", "\u00BD"],
  ["frac34", "\u00BE"],
  ["iquest", "\u00BF"],
  ["times", "\u00D7"],
  ["divide", "\u00F7"],
  // Latin-1 Supplement letters, uppercase then lowercase.
  ["Agrave", "\u00C0"],
  ["Aacute", "\u00C1"],
  ["Acirc", "\u00C2"],
  ["Atilde", "\u00C3"],
  ["Auml", "\u00C4"],
  ["Aring", "\u00C5"],
  ["AElig", "\u00C6"],
  ["Ccedil", "\u00C7"],
  ["Egrave", "\u00C8"],
  ["Eacute", "\u00C9"],
  ["Ecirc", "\u00CA"],
  ["Euml", "\u00CB"],
  ["Igrave", "\u00CC"],
  ["Iacute", "\u00CD"],
  ["Icirc", "\u00CE"],
  ["Iuml", "\u00CF"],
  ["ETH", "\u00D0"],
  ["Ntilde", "\u00D1"],
  ["Ograve", "\u00D2"],
  ["Oacute", "\u00D3"],
  ["Ocirc", "\u00D4"],
  ["Otilde", "\u00D5"],
  ["Ouml", "\u00D6"],
  ["Oslash", "\u00D8"],
  ["Ugrave", "\u00D9"],
  ["Uacute", "\u00DA"],
  ["Ucirc", "\u00DB"],
  ["Uuml", "\u00DC"],
  ["Yacute", "\u00DD"],
  ["THORN", "\u00DE"],
  ["szlig", "\u00DF"],
  ["agrave", "\u00E0"],
  ["aacute", "\u00E1"],
  ["acirc", "\u00E2"],
  ["atilde", "\u00E3"],
  ["auml", "\u00E4"],
  ["aring", "\u00E5"],
  ["aelig", "\u00E6"],
  ["ccedil", "\u00E7"],
  ["egrave", "\u00E8"],
  ["eacute", "\u00E9"],
  ["ecirc", "\u00EA"],
  ["euml", "\u00EB"],
  ["igrave", "\u00EC"],
  ["iacute", "\u00ED"],
  ["icirc", "\u00EE"],
  ["iuml", "\u00EF"],
  ["eth", "\u00F0"],
  ["ntilde", "\u00F1"],
  ["ograve", "\u00F2"],
  ["oacute", "\u00F3"],
  ["ocirc", "\u00F4"],
  ["otilde", "\u00F5"],
  ["ouml", "\u00F6"],
  ["oslash", "\u00F8"],
  ["ugrave", "\u00F9"],
  ["uacute", "\u00FA"],
  ["ucirc", "\u00FB"],
  ["uuml", "\u00FC"],
  ["yacute", "\u00FD"],
  ["thorn", "\u00FE"],
  ["yuml", "\u00FF"],
  // Typographic punctuation and currency marks.
  ["apos", "'"],
  ["ndash", "\u2013"],
  ["mdash", "\u2014"],
  ["lsquo", "\u2018"],
  ["rsquo", "\u2019"],
  ["sbquo", "\u201A"],
  ["ldquo", "\u201C"],
  ["rdquo", "\u201D"],
  ["bdquo", "\u201E"],
  ["dagger", "\u2020"],
  ["Dagger", "\u2021"],
  ["bull", "\u2022"],
  ["hellip", "\u2026"],
  ["permil", "\u2030"],
  ["prime", "\u2032"],
  ["Prime", "\u2033"],
  ["lsaquo", "\u2039"],
  ["rsaquo", "\u203A"],
  ["trade", "\u2122"],
  ["euro", "\u20AC"],
  // Maths relations that show up in result titles.
  ["minus", "\u2212"],
  ["le", "\u2264"],
  ["ge", "\u2265"],
  ["ne", "\u2260"],
  ["asymp", "\u2248"],
  ["equiv", "\u2261"],
  ["infin", "\u221E"],
  ["radic", "\u221A"],
  ["isin", "\u2208"],
  ["notin", "\u2209"],
  ["sum", "\u2211"],
  ["prod", "\u220F"],
]);
