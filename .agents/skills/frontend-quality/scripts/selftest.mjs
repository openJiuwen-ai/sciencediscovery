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
// Optional local HTML fixture tests; not ScienceDiscovery product E2E.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { checkLayout, validateContract } from './layout-checks.mjs';

const moduleUrl = process.env.SD_LAYOUT_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.SD_LAYOUT_PLAYWRIGHT_MODULE).href
  : new URL('../../../../.e2e/node_modules/playwright/index.mjs', import.meta.url).href;
let browser;
try {
  const { chromium } = await import(moduleUrl);
  browser = await chromium.launch({ headless: true,
    ...(process.env.SD_LAYOUT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.SD_LAYOUT_CHROMIUM_EXECUTABLE } : {}) });
} catch (error) {
  console.error(JSON.stringify({ status: 'BLOCKED', planned: null, executed: 0,
    reason: 'Provision the existing .e2e Playwright environment and Chromium first; nothing was installed.',
    detail: String(error.message).slice(0, 500) }, null, 2));
  process.exit(2);
}

const css = `*{box-sizing:border-box}html,body{margin:0}body{font:16px/24px sans-serif}
.label{width:250px;padding:8px}.clip{overflow:hidden}.panel{width:150px;height:80px}
button{font:inherit;padding:8px;border:1px solid #888}`;
const cases = [
  ['ordinary text', '<div id="t" class="label">Ready to run</div>', { fullText: ['#t'] }, 'PASS'],
  ['wrapped CJK and English', '<div id="t" class="label" style="width:130px;overflow-wrap:anywhere">科研结果 LongScientificIdentifierABC 中文</div>', { fullText: ['#t'] }, 'PASS'],
  ['long unbroken cropped text', '<div id="t" class="label clip" style="width:70px;white-space:nowrap">LongScientificIdentifierABC</div>', { fullText: ['#t'] }, 'FAIL', 'text-clipped-or-overflowing'],
  ['required text ellipsis is not a waiver', '<div id="t" class="label clip" style="width:70px;white-space:nowrap;text-overflow:ellipsis">VeryLongArtifactName.csv</div>', { fullText: ['#t'] }, 'FAIL'],
  ['intentional ellipsis selected for visibility only', '<div id="t" class="label clip" style="width:70px;white-space:nowrap;text-overflow:ellipsis">VeryLongArtifactName.csv</div><button id="open">Open full details</button>', { visible: ['#t'], actions: ['#open'] }, 'PASS'],
  ['line clamp', '<div id="t" style="width:100px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden">one two three four five six seven eight</div>', { fullText: ['#t'] }, 'FAIL'],
  ['vertical text crop', '<div id="t" class="clip" style="width:80px;height:24px">one two three four five six seven eight</div>', { fullText: ['#t'] }, 'FAIL'],
  ['ancestor crop', '<div class="clip" style="width:70px"><div id="t" class="label">Permission required</div></div>', { fullText: ['#t'] }, 'FAIL'],
  ['missing required selector', '<p>Missing</p>', { visible: ['#missing'] }, 'FAIL', 'missing-element'],
  ['invalid selector blocks', '<p>Ready</p>', { visible: ['['] }, 'BLOCKED', 'invalid-selector'],
  ['ambiguous selector blocks', '<p class="t">one</p><p class="t">two</p>', { visible: ['.t'] }, 'BLOCKED', 'ambiguous-selector'],
  ['display none required', '<div id="t" style="display:none">Required</div>', { visible: ['#t'] }, 'FAIL'],
  ['opacity zero required', '<div id="t" style="opacity:0">Required</div>', { visible: ['#t'] }, 'FAIL'],
  ['ancestor opacity zero', '<div style="opacity:0"><div id="t">Required</div></div>', { visible: ['#t'] }, 'FAIL'],
  ['transparent text', '<div id="t" class="label" style="color:transparent">Required</div>', { fullText: ['#t'] }, 'FAIL', 'text-not-painted'],
  ['zero-size text', '<div id="t" class="label" style="font-size:0">Required</div>', { fullText: ['#t'] }, 'FAIL'],
  ['empty label', '<div id="t" class="label" style="height:40px"></div>', { fullText: ['#t'] }, 'FAIL', 'missing-text'],
  ['off-screen required element', '<div id="t" style="position:absolute;left:-1000px">Required</div>', { visible: ['#t'] }, 'FAIL'],
  ['fully clipped required element', '<div class="clip" style="width:10px;height:10px"><div id="t" style="margin-left:50px;width:40px">Required</div></div>', { visible: ['#t'] }, 'FAIL'],
  ['hidden optional content ignored', '<div hidden>Optional</div><div id="t" class="label">Required</div>', { fullText: ['#t'] }, 'PASS'],
  ['native textarea not a full-text label', '<textarea id="t">Very long editable value</textarea>', { fullText: ['#t'] }, 'BLOCKED', 'unsupported-text-region'],
  ['canvas not a text label', '<canvas id="t" width="100" height="50"></canvas>', { fullText: ['#t'] }, 'BLOCKED'],
  ['complex transform blocks inference', '<div id="t" class="label" style="transform:rotate(5deg)">Required</div>', { fullText: ['#t'] }, 'BLOCKED'],
  ['simple translation allowed', '<div id="t" class="label" style="transform:translateX(10px)">Required</div>', { fullText: ['#t'] }, 'PASS'],
  ['shell overflow', '<div style="width:900px;height:30px">Wide</div>', { pageOverflow: true }, 'FAIL', 'page-horizontal-overflow'],
  ['bounded table scroller is valid', '<div style="max-width:100%;overflow:auto"><div style="width:900px;height:30px">Scientific data</div></div>', { pageOverflow: true }, 'PASS'],
  ['disjoint panels', '<div id="a" class="panel"></div><div id="b" class="panel"></div>', { disjoint: [{ a: '#a', b: '#b' }] }, 'PASS'],
  ['overlapping independent panels', '<div id="a" class="panel"></div><div id="b" class="panel" style="position:absolute;top:20px;left:20px"></div>', { disjoint: [{ a: '#a', b: '#b' }] }, 'FAIL', 'unexpected-region-overlap'],
  ['nested pair is a bad contract', '<div id="a" class="panel"><span id="b">Inside</span></div>', { disjoint: [{ a: '#a', b: '#b' }] }, 'BLOCKED', 'nested-regions'],
  ['click trial never submits', '<button id="go" onclick="window.__clicked=true">Send</button>', { actions: ['#go'] }, 'PASS'],
  ['blocking overlay', '<button id="go">Send</button><div style="position:fixed;inset:0;background:white"></div>', { actions: ['#go'] }, 'FAIL', 'action-not-ready'],
  ['declared enabled action is disabled', '<button id="go" disabled>Send</button>', { actions: ['#go'] }, 'FAIL'],
  ['transparent nonintercepting decoration', '<button id="go">Send</button><div style="position:fixed;inset:0;pointer-events:none;background:transparent"></div>', { actions: ['#go'] }, 'PASS'],
  ['modal state checks its own action', '<button id="background">Background</button><div style="position:fixed;inset:0;background:white"><button id="close">Close</button></div>', { actions: ['#close'] }, 'PASS'],
  ['gradient text is not an aesthetic failure', '<div id="t" class="label" style="color:transparent;background:linear-gradient(red,blue);background-clip:text">Visible gradient</div>', { fullText: ['#t'] }, 'BLOCKED'],
  ['stroked transparent text needs review', '<div id="t" class="label" style="color:transparent;-webkit-text-stroke:1px black">Visible stroke</div>', { fullText: ['#t'] }, 'BLOCKED'],
  ['generated text needs review', '<style>#t::after{content:"Visible generated label"}</style><div id="t" class="label">Label</div>', { fullText: ['#t'] }, 'BLOCKED', 'generated-content'],
  ['overlap only outside clipping is valid', '<div style="width:100px;height:50px;overflow:hidden"><div id="a" style="width:200px;height:50px"></div></div><div id="b" style="position:absolute;left:100px;top:0;width:100px;height:50px"></div>', { disjoint: [{a:'#a',b:'#b'}] }, 'PASS'],
  ['child visible overrides ancestor hidden', '<div style="visibility:hidden"><div id="t" class="label" style="visibility:visible">Visible</div></div>', { fullText: ['#t'] }, 'PASS'],
];
const results = [];
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
async function run(name, work) {
  try { await work(); results.push({ name, status: 'PASS' }); }
  catch (error) { results.push({ name, status: 'FAIL', detail: String(error.message).slice(0, 1400) }); }
}
try {
  for (const [name, body, contract, expected, kind] of cases) {
    await run(name, async () => {
      await page.setContent(`<!doctype html><style>${css}</style>${body}`);
      await page.evaluate(() => document.fonts.ready);
      const report = await checkLayout(page, contract);
      assert.equal(report.status, expected, JSON.stringify(report));
      if (kind) assert.ok(report.issues.some((i) => i.kind === kind), JSON.stringify(report));
      if (name === 'click trial never submits') assert.equal(await page.evaluate(() => !!window.__clicked), false);
    });
  }
  for (const bad of [{}, { visible: [] }, { visible: '#x' }, { pageOverflow: 'yes' },
    { fulltext: ['#x'] }, { disjoint: [{ a: '#a' }] }, { pageOverflow: true, ignoreEverything: true }]) {
    await run(`invalid contract ${JSON.stringify(bad)}`, () => assert.throws(() => validateContract(bad), TypeError));
  }
  for (const width of [320, 390, 599, 600, 601, 768, 899, 900, 901, 1179, 1180, 1181, 1440, 1920, 2560, 3840]) {
    await run(`fluid fixture ${width} CSS px`, async () => {
      await page.setViewportSize({ width, height: 800 });
      await page.setContent(`<!doctype html><style>${css}.label{max-width:100%;overflow-wrap:anywhere}</style><div id="t" class="label">Research evidence: 数据与方法</div>`);
      assert.equal((await checkLayout(page, { pageOverflow: true, fullText: ['#t'] })).status, 'PASS');
    });
  }
  for (const dpr of [1.25, 1.5, 2, 3]) {
    await run(`390 CSS px at DPR ${dpr}`, async () => {
      const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: dpr });
      try {
        const p = await c.newPage();
        await p.setContent(`<!doctype html><style>${css}</style><div id="t" class="label">High-DPI evidence</div>`);
        const r = await checkLayout(p, { pageOverflow: true, fullText: ['#t'] });
        assert.equal(r.status, 'PASS'); assert.equal(r.viewport.width, 390); assert.equal(r.viewport.dpr, dpr);
      } finally { await c.close(); }
    });
  }
  const failed = results.filter((r) => r.status !== 'PASS').length;
  console.log(JSON.stringify({ status: failed ? 'FAIL' : 'PASS', kind: 'diagnostic-fixtures-only',
    browser: browser.version(), planned: cases.length + 7 + 16 + 4,
    executed: results.length, passed: results.length - failed, failed, skipped: 0, results }, null, 2));
  process.exitCode = failed ? 1 : 0;
} finally { await context.close(); await browser.close(); }
