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
import { createElement } from "react";

import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_CHAT_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_NUDGE_STRIDE,
  PANEL_RAIL_WIDTH,
  PANEL_SHELL_GUTTER,
  PANEL_SHELL_RESERVE,
  clampPanelWidth,
  panelCeiling,
  panelWidthFromDrag,
  storedPanelWidth,
} from "../src/app/panel-width.js";
import { usePanelWidth, type PanelResize } from "../src/app/use-panel-width.js";
import { PANEL_WIDTH_STORAGE_KEY } from "../src/state/storage.js";
import { act, create } from "./support/dom-renderer.js";

// `react-test-renderer` only flushes effects inside `act` when the environment
// declares itself an act environment; the mounted tests here do.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** One of the shell's stylesheets, as the browser receives it. */
function stylesheet(name: string): string {
  return readFileSync(new URL(`../src/styles/${name}`, import.meta.url), "utf8");
}

/**
 * Everything a selector declares at the sheet's top level, in cascade order.
 *
 * The sheet is scanned rather than pattern-matched per rule: a small brace-depth
 * scan keeps only depth-0 rules, skips the bodies of at-rules such as `@media`
 * (their declarations do not apply at every width), and splits a rule's selector
 * group on commas, so `.main-area, .foo { … }` counts for `.main-area` too.
 * Every matching top-level rule is kept, in source order: a later declaration is
 * the one the browser uses, and a guard that read only the first block would
 * pass while the live column had moved.
 */
function declarations(css: string, selector: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const wanted = selector.trim();
  const blocks: string[] = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = 0;
  let inAtRule = false;
  let prelude = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      if (depth === 0) {
        prelude = source.slice(preludeStart, index);
        inAtRule = prelude.trimStart().startsWith("@");
        bodyStart = index + 1;
      }
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        const groups = prelude.split(",").map(group => group.trim().replace(/\s+/g, " "));
        if (!inAtRule && groups.includes(wanted)) blocks.push(source.slice(bodyStart, index));
        preludeStart = index + 1;
      }
    } else if (character === ";" && depth === 0) {
      preludeStart = index + 1;
    }
  }
  assert.ok(blocks.length > 0, `no top-level rule for ${selector}`);
  return blocks.join(";");
}

/** The value the cascade ends with for `property`, or `undefined`. */
function declaration(block: string, property: string): string | undefined {
  const values = [...block.matchAll(new RegExp(`(?:^|[\\s;])${property}:\\s*([^;]+);`, "g"))];
  return values.at(-1)?.[1]?.trim();
}

/** A length from the sheet: `<n>px`, a bare `0`, or `var(--d-rail)` resolved
 *  through the token it names. */
function length(raw: string, rail: number): number {
  const literal = /^(\d+)(?:px)?$/.exec(raw);
  if (literal !== null) return Number(literal[1]);
  if (/^var\(\s*--d-rail\s*\)$/.test(raw)) return rail;
  assert.fail(`unexpected length: ${raw}`);
}

/** A rule's effective value for `property`, resolved as a length. */
function lengthOf(block: string, property: string, rail: number): number {
  const raw = declaration(block, property);
  assert.ok(raw !== undefined, `the rule declares no ${property}`);
  return length(raw, rail);
}

/** The basis a `flex: 0 0 <length>` shorthand fixes for a column. */
function flexBasis(block: string, rail: number): number {
  const raw = declaration(block, "flex");
  assert.ok(raw !== undefined, "the rule declares no flex");
  const shorthand = /^0\s+0\s+(.+)$/.exec(raw);
  assert.ok(shorthand !== null, `unexpected flex shorthand: ${raw}`);
  return length(shorthand[1] ?? "", rail);
}

/** The width a rule's effective margins spend on the left and right sides;
 *  a rule that declares no margin spends nothing. */
function horizontalMargin(block: string, rail: number): number {
  let left = 0;
  let right = 0;
  for (const match of block.matchAll(/(?:^|[\s;])(margin(?:-left|-right|-inline)?):\s*([^;]+);/g)) {
    const property = match[1] ?? "";
    const values = (match[2] ?? "").trim().split(/\s+/).map(value => length(value, rail));
    // `margin` is top/right/bottom/left, with the shorter forms folded out.
    const first = values[0] ?? 0;
    const second = values[1] ?? first;
    const fourth = values[3] ?? second;
    if (property === "margin-left") left = first;
    else if (property === "margin-right") right = first;
    else if (property === "margin-inline") {
      left = first;
      right = second;
    } else {
      right = second;
      left = fourth;
    }
  }
  return left + right;
}

test("the panel's edge follows the pointer, and the panel is on the right", () => {
  // Dragging the edge left widens the panel: the edge is what moves, not the
  // width. Getting this backwards makes the panel run away from the cursor.
  assert.equal(panelWidthFromDrag(360, 1000, 960), 400);
  assert.equal(panelWidthFromDrag(360, 1000, 1040), 320);
  assert.equal(panelWidthFromDrag(360, 1000, 1000), 360);
});

test("a drag that runs past a bound comes back where the pointer is", () => {
  // The floor is applied afterwards, so pulling the pointer far past it and
  // returning has to land on the same width — not on a panel that has to be
  // dragged back by the whole overshoot first.
  const overshot = panelWidthFromDrag(300, 1000, 1400);
  assert.ok(overshot < PANEL_MIN_WIDTH);
  assert.equal(clampPanelWidth(overshot, 1600), PANEL_MIN_WIDTH);
  assert.equal(panelWidthFromDrag(300, 1000, 900), 400);
});

test("the width stays between the two bounds", () => {
  // A window wide enough for the panel's own maximum, so the ceiling being
  // tested is the panel's rather than the window's.
  assert.equal(clampPanelWidth(120, 2400), PANEL_MIN_WIDTH);
  assert.equal(clampPanelWidth(2000, 2400), PANEL_MAX_WIDTH);
  assert.equal(clampPanelWidth(500, 2400), 500);
});

test("a window too narrow to hold both columns keeps the panel usable", () => {
  // Below the rail, the gutters and a readable transcript there is no width
  // that fits; the panel keeps its floor and the stylesheets hide it.
  const viewport = PANEL_SHELL_RESERVE + PANEL_MIN_CHAT_WIDTH - 20;
  // What the arithmetic would allow is less than the panel's own floor, and the
  // floor is what survives: a panel squeezed to 100px shows nothing.
  assert.equal(clampPanelWidth(PANEL_MAX_WIDTH, viewport), PANEL_MIN_WIDTH);
  assert.equal(clampPanelWidth(PANEL_DEFAULT_WIDTH, PANEL_SHELL_RESERVE), PANEL_MIN_WIDTH);
});

test("the ceiling leaves the transcript its minimum", () => {
  // Wide enough that the window's ceiling is above the panel's floor, so the
  // arithmetic below is the one the panel actually receives.
  const viewport = 1600;
  const ceiling = clampPanelWidth(PANEL_MAX_WIDTH, viewport);
  assert.equal(ceiling, viewport - PANEL_SHELL_RESERVE - PANEL_MIN_CHAT_WIDTH);
  // Nothing reflows around the panel, so the panel is the column that gives
  // way, and the three columns still account for the whole window.
  assert.equal(ceiling + PANEL_SHELL_RESERVE + PANEL_MIN_CHAT_WIDTH, viewport);
});

test("the reserve is the rail and its gutters, not a sidebar column", () => {
  // Measured in headless Chromium against the real `index.css` at a 1400px
  // window with the panel open: the rail is 64px, `.main-area` starts at 70
  // and is 796px wide while a 528px panel (the old 360 reserve) is open, and a
  // 812px panel leaves the transcript exactly `PANEL_MIN_CHAT_WIDTH`. So
  // 1400 - 812 - 512 = 76 is what the row spends beside the panel.
  assert.equal(clampPanelWidth(PANEL_MAX_WIDTH, 1400), 812);
  // The sidebar-inclusive reserves are visibly different from that: the
  // design's 296px sidebar (360 with the rail) would stop at 528, and the 256px
  // one the issue counts (320) at 568.
  assert.notEqual(clampPanelWidth(PANEL_MAX_WIDTH, 1400), 1400 - 360 - PANEL_MIN_CHAT_WIDTH);
  assert.notEqual(clampPanelWidth(PANEL_MAX_WIDTH, 1400), 1400 - 320 - PANEL_MIN_CHAT_WIDTH);
  // Reserving a sidebar the open panel does not share would also leave the
  // transcript short of its floor at this window.
  assert.equal(1400 - 812, PANEL_SHELL_RESERVE + PANEL_MIN_CHAT_WIDTH);
});

test("the ceiling and the transcript's minimum meet at the binding edge", () => {
  // The edge is the narrowest window where the panel can reach its own
  // maximum: one pixel less and the window's ceiling, not `PANEL_MAX_WIDTH`,
  // is what the panel receives.
  const edge = PANEL_MAX_WIDTH + PANEL_SHELL_RESERVE + PANEL_MIN_CHAT_WIDTH;
  assert.equal(clampPanelWidth(PANEL_MAX_WIDTH, edge), PANEL_MAX_WIDTH);
  const below = edge - 1;
  const ceiling = clampPanelWidth(PANEL_MAX_WIDTH, below);
  assert.equal(ceiling, PANEL_MAX_WIDTH - 1);
  // At the edge and just under it the row is still exactly full: the ceiling
  // is what gives way, never the transcript's floor.
  assert.equal(PANEL_MAX_WIDTH + PANEL_SHELL_RESERVE + PANEL_MIN_CHAT_WIDTH, edge);
  assert.equal(ceiling + PANEL_SHELL_RESERVE + PANEL_MIN_CHAT_WIDTH, below);
});

test("the reserve mirrors the live rail and the margins in the stylesheets", () => {
  // A drift guard, not arithmetic: the constant is knowable before layout, so
  // it is copied rather than measured, and the copy is what goes stale — the
  // 360 this file used to carry outlived the grid it was taken from. Read the
  // stylesheets back so a change to either number fails here instead.
  const tokens = stylesheet("tokens.css");
  const token = /--d-rail:\s*(\d+)px;/.exec(tokens);
  assert.ok(token, "tokens.css no longer declares --d-rail");
  const railFromToken = Number(token[1]);
  assert.equal(railFromToken, PANEL_RAIL_WIDTH);

  // The live shell is `design.css`'s flex row: `index.css` loads it after
  // `shell.css`, so the older sheet's grid never lays the app out.
  const design = stylesheet("design.css");
  assert.equal(declaration(declarations(design, ".app-shell"), "display"), "flex");
  // `.rail` does not read the token — it repeats the number as two literals —
  // so checking the variable alone would pass while the column on screen had
  // already moved. Read the effective declarations and accept the token-based
  // form the design should eventually use: either way the width is the value
  // the browser lays out.
  const rail = declarations(design, ".rail");
  assert.equal(lengthOf(rail, "width", railFromToken), railFromToken);
  assert.equal(lengthOf(rail, "width", railFromToken), PANEL_RAIL_WIDTH);
  assert.equal(flexBasis(rail, railFromToken), PANEL_RAIL_WIDTH);
  // The rail earns no horizontal margin of its own; the whole reserve is its
  // column plus the left margin of the two columns that follow it.
  assert.equal(horizontalMargin(rail, railFromToken), 0);
  const gutters = horizontalMargin(declarations(design, ".main-area"), railFromToken)
    + horizontalMargin(declarations(design, ".workspace-panel"), railFromToken);
  assert.equal(gutters, 2 * PANEL_SHELL_GUTTER);
  assert.equal(PANEL_SHELL_RESERVE, PANEL_RAIL_WIDTH + gutters);
});

test("a stored width is only trusted as far as its type", () => {
  assert.equal(storedPanelWidth(480), 480);
  // A value from an older shape, or one that never parsed, is the same as no
  // value at all — the default beats a guess.
  assert.equal(storedPanelWidth("480"), PANEL_DEFAULT_WIDTH);
  assert.equal(storedPanelWidth(undefined), PANEL_DEFAULT_WIDTH);
  assert.equal(storedPanelWidth(null), PANEL_DEFAULT_WIDTH);
  assert.equal(storedPanelWidth(Number.NaN), PANEL_DEFAULT_WIDTH);
});

test("the ceiling counts both gutters and stops at the panel's own maximum", () => {
  // #1296 recorded 924 / 864 / 704 as the Measured ceilings. Those were taken
  // before the two 6px margins were counted (`.main-area` and
  // `.workspace-panel` each keep `margin: 6px 0 6px 6px`), so every one of them
  // is 12px too generous: 1500 - 76 - 512 = 912, and 1280 - 76 - 512 = 692.
  assert.equal(panelCeiling(1500), 912);
  assert.equal(panelCeiling(1280), 692);
  // Wide enough, and the panel's own maximum is the ceiling instead.
  assert.equal(panelCeiling(1800), PANEL_MAX_WIDTH);
  assert.equal(clampPanelWidth(PANEL_MAX_WIDTH, 1500), 912);
});

/**
 * The wrapper `App` is not: it mounts the width hook against a fake window, so
 * the keyboard path can be pressed the way the splitter presses it. Only the
 * width is read back; that is what the splitter's `aria-valuenow` shows.
 */
let latest: PanelResize | undefined;

function Probe(): null {
  latest = usePanelWidth();
  return null;
}

interface FakeShell {
  /** What is in `PANEL_WIDTH_STORAGE_KEY`, parsed the way the hook reads it. */
  remembered(): unknown;
  /** Lay the window out at a new viewport width, as a resize does. */
  resizeTo(viewportWidth: number): Promise<void>;
  restore(): void;
}

function installShell(viewportWidth: number, rememberedWidth: number): FakeShell {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    if (!previous.has(key)) previous.set(key, Object.getOwnPropertyDescriptor(globals, key));
    // Node 22 exposes some of these as getters, so a descriptor is the only way
    // in and the only way back out.
    Object.defineProperty(globals, key, { configurable: true, value, writable: true });
  };
  const values = new Map<string, string>([[PANEL_WIDTH_STORAGE_KEY, JSON.stringify(rememberedWidth)]]);
  install("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
  });
  const listeners = new Set<() => void>();
  const fakeWindow = {
    innerWidth: viewportWidth,
    addEventListener: (type: string, listener: () => void) => {
      if (type === "resize") listeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => { listeners.delete(listener); },
  };
  install("window", fakeWindow);

  return {
    remembered: () => JSON.parse(values.get(PANEL_WIDTH_STORAGE_KEY) ?? "null"),
    resizeTo: async (next: number) => {
      fakeWindow.innerWidth = next;
      await act(async () => { for (const listener of listeners) listener(); });
    },
    restore: () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globals, key, descriptor);
        else delete globals[key];
      }
    },
  };
}

async function mount(): Promise<ReturnType<typeof create>> {
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(createElement(Probe));
  });
  return renderer!;
}

test("a nudge the window cannot show leaves the remembered width alone", async () => {
  // 1280 - 76 - 512 = 692, so the 720 the user chose cannot be laid out. One
  // Shift+ArrowLeft used to write that capped 692 down in its place, and the
  // remembered width was gone for good (#1296).
  const shell = installShell(1280, 720);
  try {
    const renderer = await mount();
    assert.equal(latest?.width, 692);
    await act(async () => { latest?.nudge(PANEL_NUDGE_STRIDE); });
    assert.equal(shell.remembered(), 720);
    assert.equal(latest?.width, 692);
    // Widening the window gives the user's width back, which a written-down
    // ceiling would have made impossible.
    await shell.resizeTo(1800);
    assert.equal(latest?.width, 720);
    // Unmounting inside `act` runs the hook's cleanup while the globals it
    // touches are still installed.
    await act(async () => { renderer.unmount(); });
  } finally {
    shell.restore();
  }
});

test("a wider remembered width survives a press against the ceiling", async () => {
  const shell = installShell(1500, PANEL_MAX_WIDTH);
  try {
    const renderer = await mount();
    assert.equal(latest?.width, 912);
    await act(async () => { latest?.nudge(PANEL_NUDGE_STRIDE); });
    assert.equal(shell.remembered(), PANEL_MAX_WIDTH);
    await shell.resizeTo(1800);
    assert.equal(latest?.width, PANEL_MAX_WIDTH);
    await act(async () => { renderer.unmount(); });
  } finally {
    shell.restore();
  }
});

test("a nudge the window can lay out is still remembered", async () => {
  // The fix is not "stop writing": a press with room to move is the user's
  // choice and has to survive a reload.
  const shell = installShell(1800, 720);
  try {
    const renderer = await mount();
    assert.equal(latest?.width, 720);
    await act(async () => { latest?.nudge(PANEL_NUDGE_STRIDE); });
    assert.equal(latest?.width, 784);
    assert.equal(shell.remembered(), 784);
    await act(async () => { renderer.unmount(); });
  } finally {
    shell.restore();
  }
});

test("a nudge that lands exactly on the ceiling is still stored", async () => {
  // The guard is "past the ceiling", not "at it": a width the window can lay
  // out is a width the user may keep.
  const shell = installShell(1500, 848);
  try {
    const renderer = await mount();
    assert.equal(latest?.width, 848);
    await act(async () => { latest?.nudge(PANEL_NUDGE_STRIDE); });
    assert.equal(latest?.width, 912);
    assert.equal(shell.remembered(), 912);
    await act(async () => { renderer.unmount(); });
  } finally {
    shell.restore();
  }
});
