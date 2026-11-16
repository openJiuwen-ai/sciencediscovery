// Regression guard (found in a live e2e run): enterStep2 referenced
// the removed #model-config element, threw on null.hidden, and silently
// killed the pollBackend loop — every fresh install froze at the boot card.
// Static contract: every $("id") the wizard JS dereferences must exist in the
// markup, and every document.querySelector(".class") must match a class.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const wizardHtml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "wizard.html"),
  "utf8",
);

test("wizard.html: every $(\"id\") reference exists in the markup", () => {
  const refs = new Set<string>();
  for (const m of wizardHtml.matchAll(/\$\("([a-z0-9-]+)"\)/gi)) refs.add(m[1]);
  // The page slimmed to a single data-dir step (6 ids); 10 was the
  // old three-step page's count.
  assert.ok(refs.size >= 5, `expected a meaningful set of id refs, got ${refs.size}`);
  const missing = [...refs].filter((id) => !new RegExp(`id="${id}"`).test(wizardHtml));
  assert.deepEqual(missing, [], "dangling $() references (null deref at runtime)");
});

test("wizard.html: every querySelector class target exists in the markup", () => {
  const refs = new Set<string>();
  for (const m of wizardHtml.matchAll(/querySelector\("\.([a-z0-9-]+)"\)/gi)) refs.add(m[1]);
  const missing = [...refs].filter((cls) => !new RegExp(`class="[^"]*\\b${cls}\\b`).test(wizardHtml));
  assert.deepEqual(missing, [], "dangling querySelector('.class') references");
});

test("wizard.html: takeover contract present (data-dir only, new design)", () => {
  // Half-takeover redesign: the shell wizard is ONLY the data-directory
  // screen; boot/self-check/model moved to the SPA (which opens at model via
  // the wizardIntroDone flag). Pin the controls this page must keep.
  assert.match(wizardHtml, /id="data-dir"/);
  assert.match(wizardHtml, /id="browse"/);
  assert.match(wizardHtml, /id="use-default"/);
  assert.match(wizardHtml, /id="dir-check"/);
  assert.match(wizardHtml, /id="next"/);
  assert.match(wizardHtml, /id="msg"/);
  // The takeover message after confirmDir — the SPA owns the window next.
  assert.match(wizardHtml, /目录已确认，正在进入系统/);
  assert.match(wizardHtml, /confirmDir/);
  // The dead legacy steps must NOT come back (they polled a backend the
  // takeover flow never starts).
  assert.doesNotMatch(wizardHtml, /只需三步/);
  assert.doesNotMatch(wizardHtml, /id="model-preset"/);
  assert.doesNotMatch(wizardHtml, /id="sc-api"/);
});
