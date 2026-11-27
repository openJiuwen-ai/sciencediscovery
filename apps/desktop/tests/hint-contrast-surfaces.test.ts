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
import { readFileSync } from "node:fs";
import {
  AA_NORMAL_TEXT,
  baseRules,
  contrast,
  declaration,
  declarations,
  parseHex,
  parsePaint,
  resolve,
  rulesReaching,
  stylesheet,
  toHex,
  type Rgb,
} from "./support/css-contrast.js";

const TOKENS = stylesheet(import.meta.url, "tokens.css");
const INDEX = stylesheet(import.meta.url, "index.css");
/** The form that owns the settings block: one hint under a field, one inside
 *  the selected capability option. Read as source so the pairing asserted
 *  below is the DOM's, not a claim made in a comment. */
const SPECIALIST_FORM = readFileSync(
  new URL("../src/views/settings/system/SpecialistForm.tsx", import.meta.url),
  "utf8",
);

/** The sheets in the order the renderer loads them, from `index.css`. */
function importOrder(): string[] {
  return [...INDEX.matchAll(/@import\s+"\.\/([a-z-]+\.css)";/g)].map(match => match[1] ?? "");
}

const ORDER = importOrder();

/**
 * The background `.workspace-panel` ends up with, which is not the first one
 * declared for it: three sheets name that selector, and the one loaded last
 * paints. Read through `index.css`'s order for that reason.
 */
function cascadeBackground(selector: string): { sheet: string; value: string } {
  let winner: { sheet: string; value: string } | undefined;
  for (const sheet of ORDER) {
    for (const rule of baseRules(stylesheet(import.meta.url, sheet), selector)) {
      const value = declaration(rule, "background") ?? declaration(rule, "background-color");
      if (value !== undefined) winner = { sheet, value };
    }
  }
  assert.ok(winner !== undefined, `no sheet declares a background for ${selector}`);
  return winner;
}

/** A background value as an opaque colour, resolved through tokens.css. */
function opaque(value: string, what: string): { hex: string; rgb: Rgb } {
  const paint = parsePaint(resolve(value, TOKENS));
  assert.ok(paint !== undefined, `${what} paints an unreadable colour: ${value}`);
  assert.equal(paint.alpha, 1, `${what} paints ${value}; a translucent surface has to be composited explicitly`);
  const rgb = { r: paint.r, g: paint.g, b: paint.b };
  return { hex: toHex(rgb), rgb };
}

/** A declared background of `selector`, from the sheet that declares it. */
function declaredBackground(sheet: string, selector: string): { hex: string; rgb: Rgb } {
  const painted = baseRules(stylesheet(import.meta.url, sheet), selector)
    .map(rule => declaration(rule, "background") ?? declaration(rule, "background-color"))
    .filter((value): value is string => value !== undefined);
  assert.equal(painted.length, 1, `${sheet} ${selector} declares ${painted.length} backgrounds; expected one`);
  return opaque(painted[0] ?? "", `${sheet} ${selector}`);
}

/** A token's value, resolved through tokens.css. */
function token(name: string): string {
  const declared = [...TOKENS.matchAll(new RegExp(`(?:^|[\\s;{])${name}:\\s*([^;]+);`, "g"))].at(-1)?.[1];
  assert.ok(declared !== undefined, `tokens.css declares no ${name}`);
  return declared.trim();
}

/**
 * Every surface a hint in this report is painted on, read from the sheets and
 * resolved through the load order rather than retyped here.
 */
const SURFACES = {
  /** The settings surface every one of these hints sits in. */
  settings: declaredBackground("design.css", ".settings-main"),
  /** The selected capability option, painted `--primary-softer`. */
  selectedOption: declaredBackground("design.css", ".settings-ability-option.is-selected"),
  /** The session flyout, which also hosts the 专家 and 会话设置 rows. */
  flyout: declaredBackground("design.css", ".session-menu-flyout"),
  /** A flyout row while the pointer is over it — when the line is being read. */
  flyoutHover: declaredBackground("design.css", ".session-flyout-row:hover"),
  /** The workspace panel as the renderer ends up painting it. */
  panel: opaque(cascadeBackground(".workspace-panel").value, ".workspace-panel"),
  /**
   * `--surface-sunk`, which `workspace.css:18` paints the panel with before
   * `workspace.css:169` and `design.css` repaint it. The panel ships white, so
   * this surface is held **defensively**: it is the colour the folder line goes
   * back to if those later declarations are ever removed, and the value is
   * chosen to clear AA there too rather than only on white.
   */
  sunk: opaque(token("--surface-sunk"), "--surface-sunk"),
} as const;

type SurfaceName = keyof typeof SURFACES;

/**
 * The hint rules this report is about, each with the surfaces it is actually
 * painted on. The pairing is the point: `.settings-ability-option-hint` is the
 * hint that renders inside the selected option, and `.settings-field-hint` is
 * not — a suite that measured the wrong one would report a ratio for a
 * combination no reader ever sees.
 */
const HINTS: { selector: string; surfaces: SurfaceName[] }[] = [
  { selector: ".settings-field-hint", surfaces: ["settings"] },
  { selector: ".settings-ability-option-hint", surfaces: ["settings", "selectedOption"] },
  { selector: ".settings-field-count", surfaces: ["settings"] },
  { selector: ".settings-textarea-count", surfaces: ["settings"] },
  { selector: ".settings-ability-divider", surfaces: ["settings"] },
  { selector: ".session-flyout-desc", surfaces: ["flyout", "flyoutHover"] },
  { selector: ".session-flyout-note", surfaces: ["flyout"] },
  { selector: ".expert-note", surfaces: ["flyout"] },
  { selector: ".doc-tab-hint", surfaces: ["panel", "sunk"] },
];

/** The one hint colour, resolved through tokens.css. */
function hintColour(selector: string): string {
  const rules = baseRules(stylesheet(import.meta.url, "design.css"), selector);
  assert.equal(rules.length, 1, `design.css declares ${selector} ${rules.length} times at the top level`);
  const colours = declarations(rules[0]!, "color");
  assert.equal(colours.length, 1, `${selector} declares ${colours.length} colours; a hint is one colour`);
  const value = resolve(colours[0] ?? "", TOKENS);
  assert.ok(parseHex(value) !== undefined, `${selector} resolves to a colour that cannot be measured: ${value}`);
  return value;
}

test("every hint in the report is the one hint colour", () => {
  // Before the fix these rules carried three literals — #808080, #8c8c8c and
  // #a6a6a6 — the same muted intent landing on a different ratio per rule.
  // They now name one token, asserted as the token rather than as a hex: a
  // literal would let the next per-surface tweak drift one of them back below
  // the floor without touching tokens.css.
  for (const hint of HINTS) {
    const rules = baseRules(stylesheet(import.meta.url, "design.css"), hint.selector);
    assert.equal(rules.length, 1, `design.css declares ${hint.selector} ${rules.length} times at the top level`);
    const colours = declarations(rules[0]!, "color");
    assert.equal(colours.length, 1, `${hint.selector} declares ${colours.length} colours: ${colours.join(", ")}`);
    assert.equal(colours[0], "var(--text-hint)", `${hint.selector} must name var(--text-hint), not ${colours[0]}`);
  }
  const colours = new Set(HINTS.map(hint => hintColour(hint.selector).toLowerCase()));
  assert.equal(colours.size, 1, `the hints declare ${[...colours].join(", ")}; one colour keeps the intent in one place`);
  console.log(`\nhint colour: ${[...colours].join(", ")} (--text-hint), ${HINTS.length} rules`);
});

test("every hint clears WCAG AA on every surface it is painted on", () => {
  // Each hint is measured against each surface it is drawn on, not against
  // white alone: `#666666` is 5.27:1 on the hovered flyout row and 5.39:1 on
  // the selected option, while a grey picked to just clear white (`#767676`,
  // 4.54:1) falls to 4.26:1 there. That is the regression this test catches.
  const reported: string[] = [];
  for (const hint of HINTS) {
    const colour = hintColour(hint.selector);
    for (const name of hint.surfaces) {
      const background = SURFACES[name];
      const ratio = contrast(parseHex(colour)!, background.rgb);
      reported.push(`${hint.selector} ${colour} on ${name} ${background.hex} = ${ratio.toFixed(2)}:1`);
      assert.ok(
        ratio >= AA_NORMAL_TEXT,
        `${hint.selector} ${colour} on ${name} ${background.hex} is ${ratio.toFixed(2)}:1, below WCAG AA ${AA_NORMAL_TEXT}:1`,
      );
    }
  }
  console.log(`\nWCAG AA hint contrast (threshold ${AA_NORMAL_TEXT}:1)\n${reported.join("\n")}`);
});

test("the hint paired with the selected option is the one rendered inside it", () => {
  // The setting form is `<label class="settings-ability-option…"><input/><span>
  // <span class="settings-ability-option-title">…</span><span class="
  // settings-ability-option-hint">…</span></span></label>`. The label is what
  // turns `--primary-softer` when chosen, so only the hint inside it is painted
  // on that surface; `.settings-field-hint` sits one level up, in
  // `.settings-ability`, and never lands on `#f4f8ff`. Asserting the source
  // keeps the surface lists above honest.
  const start = SPECIALIST_FORM.indexOf("<label className={`settings-ability-option");
  assert.ok(start >= 0, "the capability option's <label> was not found");
  const opening = SPECIALIST_FORM.slice(start, SPECIALIST_FORM.indexOf(">", start));
  assert.ok(opening.includes("is-selected"), `the option is no longer given \`is-selected\`: ${opening}`);
  const label = SPECIALIST_FORM.slice(start);
  const option = label.slice(0, label.indexOf("</label>"));
  assert.ok(option.length > 0 && option.length < label.length, "the capability option's </label> was not found");
  assert.ok(option.includes("settings-ability-option-hint"), "the option's own hint is not inside the option");
  assert.ok(
    !option.includes("settings-field-hint"),
    "a settings-field-hint is inside the capability option; the surface lists in this test would be wrong",
  );
});

test("the surfaces measured here are the ones the sheets paint", () => {
  // Pins the backgrounds above to the values the app ships. If a surface moves
  // — a flyout repainted `#fafafa`, a workspace panel retinted, a stylesheet
  // reordered — the ratios above stop describing what a reader sees, so this
  // fails instead of quietly measuring against a colour nobody paints.
  const painted = Object.fromEntries(
    Object.entries(SURFACES).map(([name, surface]) => [name, surface.hex]),
  ) as Record<SurfaceName, string>;
  assert.deepEqual(painted, {
    settings: "#ffffff",
    selectedOption: "#f4f8ff",
    flyout: "#ffffff",
    flyoutHover: "#f5f5f5",
    panel: "#ffffff",
    sunk: "#f0f0f0",
  });
  console.log(`\nsurfaces: ${Object.entries(painted).map(([name, hex]) => `${name} = ${hex}`).join(", ")}`);
});

test("the workspace panel is the surface design.css paints, not the sunk one", () => {
  // Three sheets name `.workspace-panel`: `workspace.css` paints it
  // `--surface-sunk` (#f0f0f0) in one rule and `--surface` (#fff) in another,
  // and `design.css` paints it `#fff` last. The panel a reader sees is
  // therefore white, and the folder line on it is 2.43:1 rather than the
  // 2.14:1 the report quotes from the losing rule. The fix is still held to the
  // darker surface above, which is why it clears AA either way — but the number
  // in the record has to be the one that is painted.
  const painted = baseRules(stylesheet(import.meta.url, "workspace.css"), ".workspace-panel")
    .map(rule => declaration(rule, "background"))
    .filter((value): value is string => value !== undefined);
  assert.ok(painted.includes("var(--surface-sunk)"), "workspace.css no longer paints the panel with --surface-sunk");
  assert.ok(painted.includes("var(--surface)"), "workspace.css no longer repaints the panel with --surface");
  assert.ok(ORDER.indexOf("design.css") > ORDER.indexOf("workspace.css"),
    `design.css is imported before workspace.css (${ORDER.join(" > ")}); the panel would be the sunk surface`);
  const winner = cascadeBackground(".workspace-panel");
  assert.equal(winner.sheet, "design.css", `.workspace-panel is painted by ${winner.sheet}, so the surface moved`);
  console.log(`\n.workspace-panel: ${painted.join(" / ")} in workspace.css, overridden by ${winner.sheet} ${winner.value}`);
});

test("no rule repaints a hint, so one colour cannot be traded for another", () => {
  // The degeneracy this blocks: keeping white at AA and adding a second
  // declaration for the darker surface would make "each surface passes" true of
  // two literals while the rule stops being one colour. A hint may only be
  // repainted by the documented error state, and that state must stay --danger
  // rather than a hint shade.
  for (const hint of HINTS) {
    for (const rule of rulesReaching(stylesheet(import.meta.url, "design.css"), hint.selector)) {
      const colours = declarations(rule, "color");
      if (colours.length === 0) continue;
      assert.equal(colours.length, 1, `${hint.selector} rule "${rule.prelude}" declares ${colours.length} colours`);
      const value = colours[0] ?? "";
      if (rule.prelude === `${hint.selector}.is-error`) {
        assert.equal(value, "var(--danger)", `${rule.prelude} must stay the error colour, not ${value}`);
        continue;
      }
      assert.equal(
        value,
        "var(--text-hint)",
        `${hint.selector} is repainted by "${rule.prelude}" with ${value}; a hint is one colour on every surface`,
      );
    }
  }
});

test("the fix does not reach into the shared muted tokens", () => {
  // `--muted`, `--muted-light` and `--text-faint` have roughly 250 call sites,
  // several of them not text at all, so lifting them would repaint the shell to
  // fix these rules. Their values are asserted to stay put, and the hint colour
  // is asserted to be its own token.
  assert.equal(token("--muted"), "#777777");
  assert.equal(token("--muted-light"), "#a6a6a6");
  assert.equal(token("--text-faint"), "#8c8c8c");
  assert.equal(token("--text-hint"), "#666666");
});
