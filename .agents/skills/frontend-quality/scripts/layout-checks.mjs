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

// SPDX-License-Identifier: Apache-2.0
// Original ScienceDiscovery diagnostic code, 2026-10-15; no upstream detector code.
// Opt-in: no installation, discovery, browser launch, network call or file write.

/**
 * @typedef {Object} LayoutContract
 * @property {boolean} [pageOverflow] Check ordinary document horizontal overflow.
 * @property {string[]} [visible] Unique CSS selectors expected on screen now.
 * @property {string[]} [fullText] Small ordinary text boxes requiring full display.
 * @property {string[]} [actions] Unique enabled actions, tested without clicking.
 * @property {{a:string,b:string}[]} [disjoint] Independent regions that must not overlap.
 */

/** Validate before browser work. Empty/unknown contracts cannot silently pass. */
export function validateContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new TypeError('A non-empty layout contract object is required.');
  }
  const keys = new Set(['pageOverflow', 'visible', 'fullText', 'actions', 'disjoint']);
  for (const key of Object.keys(contract)) {
    if (!keys.has(key)) throw new TypeError(`Unknown layout contract key: ${key}`);
  }
  if ('pageOverflow' in contract && typeof contract.pageOverflow !== 'boolean') {
    throw new TypeError('pageOverflow must be boolean.');
  }
  const selector = (value) => typeof value === 'string' && value.trim().length > 0;
  let count = Number(contract.pageOverflow === true);
  for (const key of ['visible', 'fullText', 'actions']) {
    if (key in contract && (!Array.isArray(contract[key]) || !contract[key].every(selector))) {
      throw new TypeError(`${key} must be an array of non-empty CSS selectors.`);
    }
    count += contract[key]?.length ?? 0;
  }
  if ('disjoint' in contract) {
    if (!Array.isArray(contract.disjoint) || !contract.disjoint.every((p) =>
      p && !Array.isArray(p) && selector(p.a) && selector(p.b) &&
      Object.keys(p).every((key) => key === 'a' || key === 'b'))) {
      throw new TypeError('disjoint must contain only {a, b} selector pairs.');
    }
    count += contract.disjoint.length;
  }
  if (!count) throw new TypeError('No checks selected; an empty scan is not PASS.');
}

/** Browser-only DOM reader. Self-contained so Playwright can serialize it. */
export function inspectLayout(contract) {
  const tolerance = 1; // CSS px, not device pixels; allow subpixel rounding.
  const issues = [];
  const measurements = [];
  const actionTargets = [];
  const viewport = {
    width: window.innerWidth, height: window.innerHeight,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    dpr: window.devicePixelRatio,
  };
  const view = { left: 0, top: 0, right: viewport.clientWidth, bottom: viewport.clientHeight };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      width: r.width, height: r.height };
  };
  const add = (rule, kind, selector, detail, blocked = false) =>
    issues.push({ rule, kind, selector, detail, severity: blocked ? 'blocked' : 'failure' });
  const find = (selector, rule) => {
    let nodes;
    try { nodes = document.querySelectorAll(selector); }
    catch { add(rule, 'invalid-selector', selector, 'Not a valid CSS selector.', true); return null; }
    if (nodes.length !== 1) {
      add(rule, nodes.length ? 'ambiguous-selector' : 'missing-element', selector,
        `Expected exactly one element; found ${nodes.length}.`, nodes.length > 1);
      return null;
    }
    return nodes[0];
  };
  const painted = (el) => {
    const r = box(el);
    if (r.width <= 0 || r.height <= 0 || !el.getClientRects().length) return false;
    if (['hidden', 'collapse'].includes(getComputedStyle(el).visibility)) return false;
    for (let a = el; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.display === 'none' || Number(s.opacity) === 0 || s.contentVisibility === 'hidden') return false;
    }
    return true;
  };
  const clips = (el) => {
    const result = [view];
    for (let a = el; a; a = a.parentElement) {
      const s = getComputedStyle(a), r = box(a);
      const x = /^(hidden|clip|scroll|auto|overlay)$/.test(s.overflowX);
      const y = /^(hidden|clip|scroll|auto|overlay)$/.test(s.overflowY);
      if (x || y) result.push({
        left: x ? r.left + a.clientLeft : -Infinity,
        right: x ? r.left + a.clientLeft + a.clientWidth : Infinity,
        top: y ? r.top + a.clientTop : -Infinity,
        bottom: y ? r.top + a.clientTop + a.clientHeight : Infinity,
      });
    }
    return result;
  };
  const visibleBounds = (el) => {
    if (!painted(el)) return null;
    const r = box(el);
    for (const c of clips(el)) {
      r.left = Math.max(r.left, c.left); r.right = Math.min(r.right, c.right);
      r.top = Math.max(r.top, c.top); r.bottom = Math.min(r.bottom, c.bottom);
    }
    return r.right > r.left && r.bottom > r.top ? r : null;
  };
  const visible = (el) => visibleBounds(el) !== null;
  // Complex painting cannot safely be inferred from rectangular bounds.
  const complex = (el) => {
    for (let a = el; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.clipPath !== 'none' || (s.clip && s.clip !== 'auto') ||
          (s.maskImage && s.maskImage !== 'none') || s.filter !== 'none' ||
          s.writingMode !== 'horizontal-tb' || (s.zoom && !['1', 'normal'].includes(s.zoom))) return true;
      if (s.transform !== 'none') {
        const m = new DOMMatrixReadOnly(s.transform);
        // Translation preserves this check's coordinate assumptions; scale/rotation do not.
        if (!m.is2D || m.a !== 1 || m.b !== 0 || m.c !== 0 || m.d !== 1) return true;
      }
    }
    return false;
  };
  const requireVisible = (el, selector, rule) => {
    measurements.push({ rule, selector, rect: box(el) });
    if (complex(el)) {
      add(rule, 'unsupported-painting', selector, 'Use rendered/interaction evidence for this painting context.', true);
      return false;
    }
    if (!visible(el)) {
      add(rule, 'not-visible', selector, 'Required element is not painted in the current visible area.');
      return false;
    }
    return true;
  };
  if (contract.pageOverflow) {
    const width = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
    measurements.push({ rule: 'FQ-01', scrollWidth: width, clientWidth: viewport.clientWidth });
    if (width > viewport.clientWidth + tolerance) {
      add('FQ-01', 'page-horizontal-overflow', 'html', `scrollWidth=${width}, clientWidth=${viewport.clientWidth}`);
    }
  }
  for (const selector of contract.visible ?? []) {
    const el = find(selector, 'FQ-02');
    if (el) requireVisible(el, selector, 'FQ-02');
  }
  for (const selector of contract.fullText ?? []) {
    const el = find(selector, 'FQ-03');
    if (!el || !requireVisible(el, selector, 'FQ-03')) continue;
    if (el.matches('input,textarea,select,svg,canvas,table,pre') ||
        el.querySelector('input,textarea,select,svg,canvas,table,pre')) {
      add('FQ-03', 'unsupported-text-region', selector, 'Choose a small ordinary text label, not a renderer/scroller/control.', true);
      continue;
    }
    if (['::before', '::after'].some((pseudo) =>
      !['none', 'normal'].includes(getComputedStyle(el, pseudo).content))) {
      add('FQ-03', 'generated-content', selector, 'Generated content needs rendered evidence.', true);
      continue;
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node, textCount = 0, failure = null, unsupported = false;
    const fit = box(el);
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim()) continue;
      textCount++;
      const parent = node.parentElement, style = getComputedStyle(parent);
      if (!painted(parent)) { unsupported = true; continue; }
      if (complex(parent)) { unsupported = true; continue; }
      const transparent = /^(transparent|rgba\([^)]*,\s*0(?:\.0+)?\))$/.test(style.color);
      const transparentFill = /^(transparent|rgba\([^)]*,\s*0(?:\.0+)?\))$/.test(style.webkitTextFillColor);
      if ((transparent || transparentFill) &&
          (style.backgroundClip.includes('text') || style.textShadow !== 'none' ||
           parseFloat(style.webkitTextStrokeWidth) > 0)) {
        unsupported = true; continue; // A transparent fill can still paint a valid glyph.
      }
      if (parseFloat(style.fontSize) === 0 || transparent || transparentFill) {
        failure = 'text-not-painted'; break;
      }
      const range = document.createRange(); range.selectNodeContents(node);
      const rects = [...range.getClientRects()]; range.detach();
      if (!rects.length) { failure = 'text-not-painted'; break; }
      const bounds = [fit, ...clips(parent)];
      if (rects.some((r) => bounds.some((c) =>
        r.left < c.left - tolerance || r.right > c.right + tolerance ||
        r.top < c.top - tolerance || r.bottom > c.bottom + tolerance))) {
        failure = 'text-clipped-or-overflowing'; break;
      }
    }
    if (!textCount) add('FQ-03', 'missing-text', selector, 'This contract requires a non-empty ordinary text label.');
    else if (failure) add('FQ-03', failure, selector, 'Required full text does not fit its box/visible clipping region.');
    else if (unsupported) add('FQ-03', 'hidden-or-complex-descendant', selector,
      'Cannot infer which descendant text is intended; select the exact visible label.', true);
  }
  for (const pair of contract.disjoint ?? []) {
    const a = find(pair.a, 'FQ-05'), b = find(pair.b, 'FQ-05');
    if (!a || !b) continue;
    if (a.contains(b) || b.contains(a)) {
      add('FQ-05', 'nested-regions', `${pair.a} / ${pair.b}`, 'Select independent regions, not ancestor/descendant.', true);
      continue;
    }
    if (!requireVisible(a, pair.a, 'FQ-05') || !requireVisible(b, pair.b, 'FQ-05')) continue;
    // Compare the painted intersections, not off-screen/clipped box extensions.
    const ar = visibleBounds(a), br = visibleBounds(b);
    const width = Math.min(ar.right, br.right) - Math.max(ar.left, br.left);
    const height = Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top);
    if (width > tolerance && height > tolerance) {
      add('FQ-05', 'unexpected-region-overlap', `${pair.a} / ${pair.b}`, `intersection=${width}×${height} CSS px`);
    }
  }
  for (const selector of contract.actions ?? []) {
    const el = find(selector, 'FQ-04');
    if (el && requireVisible(el, selector, 'FQ-04')) actionTargets.push(selector);
  }
  return { viewport, toleranceCssPx: tolerance, issues, measurements, actionTargets };
}

/**
 * Read current geometry and trial only explicitly enabled actions. No model API.
 * @param {object} page Existing Playwright Page, already in the intended user state.
 * @param {LayoutContract} contract State-specific expectations; never a full-DOM scan.
 */
export async function checkLayout(page, contract) {
  validateContract(contract);
  if (!page || typeof page.evaluate !== 'function' || typeof page.locator !== 'function') {
    throw new TypeError('An existing Playwright Page is required.');
  }
  const { actionTargets, ...report } = await page.evaluate(inspectLayout, contract);
  for (const selector of actionTargets) {
    try {
      // Playwright waits for stability and verifies event reception; does not click.
      // It may scroll. The caller owns scenario readiness and scroll expectations.
      await page.locator(selector).click({ trial: true, timeout: 1000 });
    } catch (error) {
      if (error?.name !== 'TimeoutError') throw error; // browser/tool failures are not layout findings
      report.issues.push({ rule: 'FQ-04', kind: 'action-not-ready', selector,
        severity: 'failure', detail: 'Expected enabled action failed Playwright actionability within 1000ms.' });
    }
  }
  report.status = report.issues.some((i) => i.severity === 'failure') ? 'FAIL'
    : report.issues.length ? 'BLOCKED' : 'PASS';
  report.selectedChecks = Number(contract.pageOverflow === true) +
    ['visible', 'fullText', 'actions', 'disjoint'].reduce((n, k) => n + (contract[k]?.length ?? 0), 0);
  return report;
}
