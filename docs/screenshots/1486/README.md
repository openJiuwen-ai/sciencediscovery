# Issue #1486 — desktop hint contrast, before and after

Frames for the WCAG AA contrast fix to the desktop sidebar's hint text and the
landing tagline. The change is colour only: one token, `--text-hint: #666666`,
replaces four per-rule literals.

## How they were captured

- **Harness:** the real `Sidebar` component rendered with `react-dom/server`
  against the shipped `apps/desktop/src/styles/index.css`, inside the app's own
  `.app-shell` and an empty `.main-area` column. The landing frames are the
  welcome page's lockup (mascot, wordmark, tagline) with the shipped classes and
  strings; the composer under it is omitted because it is not what changed. The
  full Electron window is not automated in this environment.
- **Fixtures:** one Project with eight Sessions (more than the column's page of
  six, so the page rule and the "show older" row both render), one Project with
  none (the empty state), and two standalone Sessions. The first Session is open,
  so its row is the `#e8e8e8` active row the timestamp is measured on. The
  interface language is switched with the app's own `setLanguage`.
- **Before:** the same markup and geometry with only the four pre-fix literals
  re-applied as a same-page override — `#777` (`.side-label`, `.side-more`),
  `#808080` (`.side-session-time`), `#a6a6a6` (`.side-project-rule`,
  `.side-empty`), `#8c8c8c` (`.landing-tagline`). Nothing else is overridden, so
  the pair differs only in those colours.
- **Browser:** headless Chromium, device scale factor 2, then the sidebar column
  cropped to its 296px width and the landing lockup cropped to the brand block.
  Sizes: sidebar frames 600×1800, landing frames 860×200. Animations and
  transitions are disabled for the captures, so the landing lockup is fully
  settled rather than caught mid-fade.

## Colours measured in the same run

`getComputedStyle` on the rendered pages gives `rgb(102, 102, 102)` for every
hint in the after frames, and `rgb(119, 119, 119)` / `rgb(128, 128, 128)` /
`rgb(166, 166, 166)` in the before frames. WCAG 2.x ratios for the after value:
5.27:1 on the sidebar `#f5f5f5`, 4.69:1 on the open row `#e8e8e8`, 4.86:1 on the
4 % `#191919` hover composite `#ececec`, 5.74:1 on the landing's white.

Read off the PNGs, the tagline's glyph core is exactly `#8c8c8c` before and
`#666666` after; on the crop's own backdrop (`rgb(221, 231, 246)`, the haze patch
behind the lockup when the composer is not drawn) that is 4.60:1 after and
2.70:1 before. The pair differs in 2,468 of 172,000 pixels, all inside the
tagline's band, and both frames are 860×200.

## Files

| file | what it shows |
| --- | --- |
| `sidebar-zh-before.png` / `sidebar-zh-after.png` | the sidebar column, zh-CN, pre-fix literals vs. `--text-hint` |
| `sidebar-en-before.png` / `sidebar-en-after.png` | the same, en |
| `landing-zh-before.png` / `landing-zh-after.png` | the landing tagline, zh-CN, `#8c8c8c` vs. `#666666` |
| `landing-en-after.png` | the landing tagline at `--text-hint`, en (after only: one token paints both) |
