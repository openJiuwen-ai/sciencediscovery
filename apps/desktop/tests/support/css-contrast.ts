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
 * Reading the desktop's stylesheets in a test: which rules a selector actually
 * reaches, what each one declares, and what contrast that declaration paints.
 *
 * Kept here rather than in a test file because more than one test asks the same
 * question, and because a contrast number that is not read off the shipped
 * sheet is a number about the test, not about the app.
 */
import { readFileSync } from "node:fs";

/** WCAG 2.x AA for normal-size text: 4.5:1. */
export const AA_NORMAL_TEXT = 4.5;

export type Rgb = { r: number; g: number; b: number };
/** A colour with its alpha, so a translucent overlay can be composited. */
export type Paint = Rgb & { alpha: number };
/** One top-level CSS rule, prelude and body as written. */
export type Rule = { prelude: string; body: string };

/** One of the desktop's stylesheets, as the browser receives it. */
export function stylesheet(base: URL, name: string): string {
  return readFileSync(new URL(`../src/styles/${name}`, base), "utf8");
}

/**
 * Every top-level rule of a sheet, in source order.
 *
 * Brace depth keeps only top-level rules, at-rules are kept but marked by their
 * prelude so a caller can skip them, and comments are stripped first so a `{`
 * inside one cannot move the depth count.
 */
export function rules(css: string): Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: Rule[] = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = 0;
  let prelude = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      if (depth === 0) {
        prelude = source.slice(preludeStart, index);
        bodyStart = index + 1;
      }
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        found.push({ prelude: normalise(prelude), body: source.slice(bodyStart, index) });
        preludeStart = index + 1;
      }
    } else if (character === ";" && depth === 0) {
      preludeStart = index + 1;
    }
  }
  return found;
}

/** A prelude with its whitespace collapsed, so comparisons are textual only. */
function normalise(prelude: string): string {
  return prelude.trim().replace(/\s+/g, " ");
}

/** The comma-separated selectors of a rule. */
export function selectorGroup(rule: Rule): string[] {
  return rule.prelude.split(",").map(group => normalise(group));
}

/**
 * The rules that reach an element carrying `selector`.
 *
 * Three forms all reach it: the selector itself (`.doc-tab-hint`), a state
 * variant of it (`.doc-tab-hint:hover`), and a descendant chain ending in it
 * (`:root:lang(zh) .doc-tab-hint`). At-rules are skipped: their declarations do
 * not apply everywhere, so a value measured from one would not be the value
 * most readers see.
 */
export function rulesReaching(css: string, selector: string): Rule[] {
  const escaped = escape(selector);
  const base = new RegExp(`^${escaped}$`);
  const variant = new RegExp(`^${escaped}(?![\\w-])`);
  const descendant = new RegExp(`(?:^|\\s)${escaped}$`);
  return rules(css).filter(rule => {
    if (rule.prelude.startsWith("@")) return false;
    return selectorGroup(rule).some(group => base.test(group) || variant.test(group) || descendant.test(group));
  });
}

/** The rules that are the selector itself, with no state and no ancestor. */
export function baseRules(css: string, selector: string): Rule[] {
  const base = new RegExp(`^${escape(selector)}$`);
  return rules(css).filter(rule => !rule.prelude.startsWith("@") && selectorGroup(rule).some(group => base.test(group)));
}

function escape(selector: string): string {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every value a rule declares for `property`, in source order. */
export function declarations(rule: Rule, property: string): string[] {
  return [...rule.body.matchAll(new RegExp(`(?:^|[\\s;])${property}:\\s*([^;]+);`, "g"))].map(match => (match[1] ?? "").trim());
}

/** The value the cascade ends with for `property`, or `undefined`. */
export function declaration(rule: Rule, property: string): string | undefined {
  return declarations(rule, property).at(-1);
}

/** A `#rgb`/`#rrggbb` colour, or `undefined` for anything else. */
export function parseHex(raw: string): Rgb | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (hex === null) return undefined;
  const digits = hex[1] ?? "";
  const full = digits.length === 3 ? [...digits].map(digit => digit + digit).join("") : digits;
  const channel = (offset: number) => Number.parseInt(full.slice(offset, offset + 2), 16);
  return { r: channel(0), g: channel(2), b: channel(4) };
}

/** A `#rgb`/`#rrggbb`, `rgb()` or `rgba()` value, or `undefined`. */
export function parsePaint(raw: string): Paint | undefined {
  const opaque = parseHex(raw);
  if (opaque !== undefined) return { ...opaque, alpha: 1 };
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(raw.trim());
  if (rgba === null) return undefined;
  const channel = (offset: number) => Number(rgba[offset] ?? "0");
  return { r: channel(1), g: channel(2), b: channel(3), alpha: Number(rgba[4] ?? "1") };
}

/** `#rrggbb` for an opaque colour. */
export function toHex({ r, g, b }: Rgb): string {
  const channel = (value: number) => Math.round(value).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** `overlay` painted on `base`, as the browser composites translucent paint. */
export function composite(base: Rgb, overlay: Paint): Rgb {
  const blend = (under: number, over: number) => under * (1 - overlay.alpha) + over * overlay.alpha;
  return { r: blend(base.r, overlay.r), g: blend(base.g, overlay.g), b: blend(base.b, overlay.b) };
}

/**
 * The value a declaration paints, with `var(--token)` read from tokens.css.
 * Resolving through the token file is the point of the exercise: the fix is one
 * hint colour, and a check that only compared literals would miss it drifting.
 */
export function resolve(raw: string, tokens: string): string {
  const value = raw.trim();
  const token = /^var\(\s*(--[a-z-]+)\s*\)$/.exec(value);
  if (token === null) return value;
  const name = token[1] ?? "";
  const declared = [...tokens.matchAll(new RegExp(`(?:^|[\\s;{])${name}:\\s*([^;]+);`, "g"))].at(-1)?.[1];
  if (declared === undefined) throw new Error(`tokens.css declares no ${name}`);
  return declared.trim();
}

/** WCAG 2.x relative luminance of an sRGB colour. */
export function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The contrast ratio between two opaque sRGB colours, 1–21. */
export function contrast(foreground: Rgb, background: Rgb): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
