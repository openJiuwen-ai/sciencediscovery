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
 * Minimal HTML helpers shared by the free search engines.
 *
 * The free engines read public result pages, so they need block splitting and
 * text extraction but not a DOM. Keeping this to a few well-tested functions
 * avoids pulling a parser (and its transitive tree) into the control plane for
 * three scrapers, and keeps every engine failing the same way when a page
 * changes: no blocks matched → no results → the aggregation moves on.
 */

/**
 * Named character references the extractor decodes.
 *
 * The names and their code points are facts stated by the HTML Standard
 * (https://html.spec.whatwg.org/multipage/named-characters.html); this is a
 * record of that data, not a copied third-party implementation. It is
 * deliberately bounded rather than the full set of 2231 named references (2125
 * of them `;`-terminated): it covers what
 * result titles and snippets actually emit — the Latin-1 accented letters (and
 * the symbols beside them), typographic punctuation, the Greek alphabet, and
 * the mathematical and card-suit symbols a scientific result page tends to use
 * — and stays small enough to read in review. A name outside the table stays
 * exactly as written, which is the failure mode the extractor already had for
 * every name but five, and adding one is a one-token edit in its group. The
 * table lives here rather than in a sibling module because the `.gitignore`
 * local-run `data-*` directory pattern also matches `packages/data-source/`, so
 * a new file in this package would have to be force-added to be committed.
 *
 * `name:code-point` pairs in hexadecimal, space separated, grouped by the block
 * a reviewer would look them up in.
 */
const REFERENCE_GROUPS: readonly string[] = [
  // ASCII and the rest of the Latin-1 Supplement: the accents that turn up in
  // European titles (`caf&eacute;`, `M&uuml;ller`, `a&ntilde;o`) and the symbols
  // beside them (`&copy;`, `&deg;`, `&plusmn;`, `&times;`, `&frac12;`).
  "amp:26 lt:3c gt:3e quot:22 apos:27 nbsp:a0 iexcl:a1 cent:a2 pound:a3 curren:a4 yen:a5 brvbar:a6 sect:a7 uml:a8 copy:a9 ordf:aa laquo:ab not:ac shy:ad reg:ae macr:af deg:b0 plusmn:b1 sup2:b2 sup3:b3 acute:b4 micro:b5 para:b6 middot:b7 cedil:b8 sup1:b9 ordm:ba raquo:bb frac14:bc frac12:bd frac34:be iquest:bf times:d7 divide:f7",
  "Agrave:c0 Aacute:c1 Acirc:c2 Atilde:c3 Auml:c4 Aring:c5 AElig:c6 Ccedil:c7 Egrave:c8 Eacute:c9 Ecirc:ca Euml:cb Igrave:cc Iacute:cd Icirc:ce Iuml:cf ETH:d0 Ntilde:d1 Ograve:d2 Oacute:d3 Ocirc:d4 Otilde:d5 Ouml:d6 Oslash:d8 Ugrave:d9 Uacute:da Ucirc:db Uuml:dc Yacute:dd THORN:de szlig:df",
  "agrave:e0 aacute:e1 acirc:e2 atilde:e3 auml:e4 aring:e5 aelig:e6 ccedil:e7 egrave:e8 eacute:e9 ecirc:ea euml:eb igrave:ec iacute:ed icirc:ee iuml:ef eth:f0 ntilde:f1 ograve:f2 oacute:f3 ocirc:f4 otilde:f5 ouml:f6 oslash:f8 ugrave:f9 uacute:fa ucirc:fb uuml:fc yacute:fd thorn:fe yuml:ff",
  // Latin Extended-A, the part that appears in Central-European and Turkish
  // names: `&Scaron;`, `&zcaron;`, `&oelig;`, `&Yuml;`.
  "OElig:152 oelig:153 Scaron:160 scaron:161 Yuml:178 Zcaron:17d zcaron:17e fnof:192 circ:2c6 tilde:2dc",
  // The Greek alphabet, for chemistry and physics titles (`&alpha;`, `&mu;`,
  // `&Omega;`) and its two variant forms.
  "Alpha:391 Beta:392 Gamma:393 Delta:394 Epsilon:395 Zeta:396 Eta:397 Theta:398 Iota:399 Kappa:39a Lambda:39b Mu:39c Nu:39d Xi:39e Omicron:39f Pi:3a0 Rho:3a1 Sigma:3a3 Tau:3a4 Upsilon:3a5 Phi:3a6 Chi:3a7 Psi:3a8 Omega:3a9",
  "alpha:3b1 beta:3b2 gamma:3b3 delta:3b4 epsilon:3b5 zeta:3b6 eta:3b7 theta:3b8 iota:3b9 kappa:3ba lambda:3bb mu:3bc nu:3bd xi:3be omicron:3bf pi:3c0 rho:3c1 sigmaf:3c2 sigma:3c3 tau:3c4 upsilon:3c5 phi:3c6 chi:3c7 psi:3c8 omega:3c9 thetasym:3d1 upsih:3d2 piv:3d6",
  // Typographic punctuation and the currency/legal marks that share its block:
  // the dashes, curly quotes and ellipsis a rendered title is full of.
  "ensp:2002 emsp:2003 thinsp:2009 zwnj:200c zwj:200d lrm:200e rlm:200f ndash:2013 mdash:2014 lsquo:2018 rsquo:2019 sbquo:201a ldquo:201c rdquo:201d bdquo:201e dagger:2020 Dagger:2021 bull:2022 hellip:2026 permil:2030 prime:2032 Prime:2033 lsaquo:2039 rsaquo:203a oline:203e frasl:2044 euro:20ac trade:2122 alefsym:2135",
  // Arrows, so a snippet like `5 &rarr; 10` reads as text instead of codes.
  "larr:2190 uarr:2191 rarr:2192 darr:2193 harr:2194 crarr:21b5 lArr:21d0 uArr:21d1 rArr:21d2 dArr:21d3 hArr:21d4",
  // Mathematical operators and relations, plus the card suits: the notation a
  // paper abstract uses (`&le;`, `&asymp;`, `&sum;`) and the `&diams;` that
  // appears in journal front matter.
  "forall:2200 part:2202 exist:2203 empty:2205 nabla:2207 isin:2208 notin:2209 ni:220b prod:220f sum:2211 minus:2212 lowast:2217 radic:221a prop:221d infin:221e ang:2220 and:2227 or:2228 cap:2229 cup:222a int:222b there4:2234 sim:223c cong:2245 asymp:2248 ne:2260 equiv:2261 le:2264 ge:2265 sub:2282 sup:2283 nsub:2284 sube:2286 supe:2287 oplus:2295 otimes:2297 perp:22a5 sdot:22c5",
  "lceil:2308 rceil:2309 lfloor:230a rfloor:230b lang:27e8 rang:27e9 loz:25ca spades:2660 clubs:2663 hearts:2665 diams:2666",
];

/** The highest Unicode scalar value; read by the loader through `decodableCodePoint`. */
const MAX_CODE_POINT = 0x10_ffff;

/** A code point in the table is lowercase hexadecimal; anything else is a typo. */
const CODE_POINT_FIELD = /^[0-9a-f]{1,6}$/;

/**
 * Parses the `name:hex` groups into the map the decoder reads.
 *
 * Exported so `html.test.ts` can prove each rejection below: a private loader
 * would let a later edit drop a guard with nothing failing. It is not part of
 * the package's public API (`index.ts` does not re-export it).
 */
export function decodeTable(groups: readonly string[]): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const group of groups) {
    for (const pair of group.split(" ")) {
      const separator = pair.indexOf(":");
      if (separator <= 0) throw new Error(`malformed named reference entry: ${JSON.stringify(pair)}`);
      const name = pair.slice(0, separator);
      const field = pair.slice(separator + 1);
      // `Number.parseInt` stops at the first character it cannot read, so a
      // typo like `eacute:e9x` would silently become U+00E9. Validate the field
      // as written instead of the value it happens to parse to.
      if (!CODE_POINT_FIELD.test(field)) throw new Error(`malformed named reference code point: ${JSON.stringify(pair)}`);
      const point = Number.parseInt(field, 16);
      // The same predicate the numeric path uses, so a table entry cannot smuggle
      // in a lone surrogate or a non-character that `&#...;` would reject.
      if (!decodableCodePoint(point)) throw new Error(`named reference is not a decodable scalar: ${JSON.stringify(pair)}`);
      // Repeating a name is a table mistake, not a last-wins update: the second
      // entry would keep the size unchanged and quietly win.
      if (entries.has(name)) throw new Error(`duplicate named reference: ${JSON.stringify(name)}`);
      entries.set(name, String.fromCodePoint(point));
    }
  }
  return entries;
}

const TABLE: ReadonlyMap<string, string> = decodeTable(REFERENCE_GROUPS);

/**
 * The table above, except for `nbsp`.
 *
 * `nbsp` keeps decoding to a plain space rather than U+00A0: `textOf` collapses
 * whitespace right after decoding and the callers treat the result as the word
 * break a non-breaking space stands for, so mapping it to U+00A0 would change
 * existing extracted titles and snippets. That keeps this change to the names
 * that were previously left literal. Exported so `html.test.ts` can assert the
 * table's shape.
 */
export const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([...TABLE, ["nbsp", " "]]);

/** Matches one reference in the source; its replacement is never scanned again,
 *  which is what keeps `&amp;lt;` at the two characters `&lt;`. */
const CHARACTER_REFERENCE = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]*));/g;

/** Only scalars that survive UTF-8 and JSON: no lone surrogate, no non-character. */
function decodableCodePoint(point: number): boolean {
  if (!Number.isInteger(point) || point <= 0 || point > MAX_CODE_POINT) return false;
  if (point >= 0xd800 && point <= 0xdfff) return false;
  const trail = point & 0xffff;
  return trail !== 0xfffe && trail !== 0xffff;
}

export function decodeEntities(value: string): string {
  return value.replace(CHARACTER_REFERENCE, (match: string, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES.get(name) ?? match;
    const point = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? "", 16);
    return decodableCodePoint(point) ? String.fromCodePoint(point) : match;
  });
}

/** Strip tags, decode entities, and collapse whitespace into one line. */
export function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * Split a document into one chunk per opening tag match.
 *
 * Each chunk runs from its own match to the next one (or the end), which is
 * enough to scope per-result sub-extraction without tracking nesting. Result
 * blocks on these pages are siblings, so a chunk never swallows the next one.
 */
export function sliceBlocks(html: string, opening: RegExp): string[] {
  const pattern = new RegExp(opening.source, opening.flags.includes("g") ? opening.flags : `${opening.flags}g`);
  const starts: number[] = [];
  for (const match of html.matchAll(pattern)) {
    if (match.index !== undefined) starts.push(match.index);
  }
  return starts.map((start, index) => html.slice(start, starts[index + 1] ?? html.length));
}

/** First capture group of the first match, or undefined. */
export function firstMatch(fragment: string, pattern: RegExp): string | undefined {
  return fragment.match(pattern)?.[1];
}
