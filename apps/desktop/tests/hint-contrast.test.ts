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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import {
  AA_NORMAL_TEXT,
  baseRules,
  composite,
  contrast,
  declaration,
  parseHex,
  parsePaint,
  resolve,
  rulesReaching,
  stylesheet,
  toHex,
  type Rgb,
} from "./support/css-contrast.js";

const TOKENS = stylesheet(import.meta.url, "tokens.css");

/** A `#rrggbb` colour from a literal in this file. */
function hex(raw: string): Rgb {
  const rgb = parseHex(raw);
  assert.ok(rgb !== undefined, `not a hex colour: ${raw}`);
  return rgb;
}

/** The value a hint's rule declares, resolved through tokens.css. */
function resolveColour(raw: string, tokens: string): string {
  const value = resolve(raw, tokens);
  assert.ok(parseHex(value) !== undefined, `not an opaque hex colour: ${value}`);
  return value;
}

/**
 * The surfaces a sidebar hint is painted on. A hint is not always on the bare
 * column: the open session's row is `.side-row.side-sub.is-active` at
 * `#e8e8e8`, and hover paints `rgba(25, 25, 25, 0.04)` over the sidebar, which
 * composites to `#ececec`. A value chosen against `#f5f5f5` alone (such as
 * `#6a6a6a`, 4.96:1) drops below AA on the active row, so all three are
 * asserted — and the second test below reads them back off the sheets rather
 * than trusting these literals.
 */
const SURFACES = [
  { name: "sidebar #f5f5f5", colour: hex("#f5f5f5") },
  { name: "active row #e8e8e8", colour: hex("#e8e8e8") },
  { name: "hover composite #ececec", colour: hex("#ececec") },
];

/** Every informational hint this half of the report paints in muted grey. The
 *  two `.side-empty` entries are deliberate: `shell.css` and `design.css` both
 *  declare it, and the shipped element is the 13 px `design.css` one.
 *  `.landing-tagline` is painted on the white landing surface, which is lighter
 *  than any sidebar surface, so measuring it against the sidebar's three is the
 *  stricter check rather than a mismatch. */
const HINTS = [
  { sheet: "design.css", selector: ".side-session-time" },
  { sheet: "design.css", selector: ".side-empty" },
  { sheet: "design.css", selector: ".side-project-rule" },
  { sheet: "design.css", selector: ".side-label" },
  { sheet: "design.css", selector: ".side-more" },
  { sheet: "landing.css", selector: ".landing-tagline" },
  { sheet: "shell.css", selector: ".side-empty" },
] as const;

/** The colour a hint's own rule declares, resolved through tokens.css. */
function hintColour(hint: (typeof HINTS)[number]): string {
  const rules = baseRules(stylesheet(import.meta.url, hint.sheet), hint.selector);
  assert.equal(rules.length, 1, `${hint.sheet} declares ${hint.selector} ${rules.length} times at the top level`);
  const raw = declaration(rules[0]!, "color");
  assert.ok(raw !== undefined, `${hint.sheet} ${hint.selector} declares no color`);
  return resolveColour(raw, TOKENS);
}

test("every hint clears WCAG AA on every surface it is painted on", () => {
  // The bug this guards: the five literals before the fix were #a6a6a6
  // (2.23:1), #808080 (3.62:1), #8c8c8c (3.36:1 on white) and #777777
  // (4.11:1) — the same muted intent landing on a different ratio in every
  // rule. Each is now the one hint colour, and each is measured here rather
  // than read off the sheet's intent.
  const reported: string[] = [];
  const declared = new Set<string>();
  for (const hint of HINTS) {
    const colour = hintColour(hint);
    declared.add(colour.toLowerCase());
    for (const surface of SURFACES) {
      const ratio = contrast(hex(colour), surface.colour);
      reported.push(`${hint.sheet} ${hint.selector} ${colour} on ${surface.name} = ${ratio.toFixed(2)}:1`);
      assert.ok(
        ratio >= AA_NORMAL_TEXT,
        `${hint.sheet} ${hint.selector} ${colour} on ${surface.name} is ${ratio.toFixed(2)}:1, below WCAG AA ${AA_NORMAL_TEXT}:1`,
      );
    }
  }
  assert.equal(
    declared.size,
    1,
    `the hints declare ${[...declared].join(", ")}; one hint colour keeps the muted intent in a single place`,
  );
  console.log(`\nWCAG AA hint contrast (threshold ${AA_NORMAL_TEXT}:1)\n${reported.join("\n")}`);
});

test("the surfaces the hints are measured on are the ones the shell paints", () => {
  // Guards the three values above: the sidebar is `.sidebar`'s own background,
  // the open row is `.side-row.side-sub.is-active`, and hover is the
  // `.side-row:hover` overlay composited over the sidebar. If a surface moves,
  // the ratios in the test above must be recomputed rather than silently
  // measured against a background that is no longer painted.
  const design = stylesheet(import.meta.url, "design.css");
  const background = (selector: string, sheet: string) => {
    const rules = baseRules(sheet, selector);
    assert.equal(rules.length, 1, `${sheet} declares ${selector} ${rules.length} times at the top level`);
    const raw = declaration(rules[0]!, "background");
    assert.ok(raw !== undefined, `${selector} declares no background`);
    const paint = parsePaint(resolve(raw, TOKENS));
    assert.ok(paint !== undefined, `unexpected background for ${selector}: ${raw}`);
    return paint;
  };

  const sidebar = background(".sidebar", design);
  const activeRow = background(".side-row.side-sub.is-active", design);
  const hoverOverlay = background(".side-row:hover", design);
  const hoverRow = composite(sidebar, hoverOverlay);

  const painted = [toHex(sidebar), toHex(activeRow), toHex(hoverRow)];
  const expected = SURFACES.map(surface => toHex(surface.colour));
  assert.deepEqual(painted, expected, `the hint surfaces are ${painted.join(", ")}, not ${expected.join(", ")}`);
  console.log(`\nhint surfaces painted by the shell: ${SURFACES.map((surface, index) => `${surface.name} = ${painted[index]}`).join(", ")}`);
});

test("state and language variants of a hint stay above AA too", () => {
  // A state rule that repaints a hint is the other way this regresses: the
  // guard above reads the base rule only. `.side-more:hover` deliberately
  // repaints to `--text-strong`, which clears AA, and the `:root:lang(zh)`
  // tagline rule declares no colour by design — it only retracks the type — so
  // it is skipped rather than counted as a gap.
  for (const hint of HINTS) {
    for (const rule of rulesReaching(stylesheet(import.meta.url, hint.sheet), hint.selector)) {
      const raw = declaration(rule, "color");
      if (raw === undefined) continue;
      const colour = resolveColour(raw, TOKENS);
      for (const surface of SURFACES) {
        const ratio = contrast(hex(colour), surface.colour);
        assert.ok(
          ratio >= AA_NORMAL_TEXT,
          `${hint.sheet} ${hint.selector} variant "${rule.prelude}" ${colour} on ${surface.name} is ${ratio.toFixed(2)}:1, below WCAG AA ${AA_NORMAL_TEXT}:1`,
        );
      }
    }
  }
});
