// F10.8 regression guard (found live in the dist6 e2e): enterStep2 referenced
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
  assert.ok(refs.size >= 10, `expected a meaningful set of id refs, got ${refs.size}`);
  const missing = [...refs].filter((id) => !new RegExp(`id="${id}"`).test(wizardHtml));
  assert.deepEqual(missing, [], "dangling $() references (null deref at runtime)");
});

test("wizard.html: every querySelector class target exists in the markup", () => {
  const refs = new Set<string>();
  for (const m of wizardHtml.matchAll(/querySelector\("\.([a-z0-9-]+)"\)/gi)) refs.add(m[1]);
  const missing = [...refs].filter((cls) => !new RegExp(`class="[^"]*\\b${cls}\\b`).test(wizardHtml));
  assert.deepEqual(missing, [], "dangling querySelector('.class') references");
});

test("wizard.html: F8.2 flow markers present (three steps, model step optional)", () => {
  assert.match(wizardHtml, /只需三步/);
  assert.match(wizardHtml, /② 启动与自检/);
  assert.match(wizardHtml, /③ 模型配置/);
  assert.match(wizardHtml, /id="model-preset"/);
  assert.match(wizardHtml, /id="model-api-key"/);
  assert.match(wizardHtml, /id="model-base-url"/);
  assert.match(wizardHtml, /id="model-select"/);
  assert.match(wizardHtml, /id="refresh-models"/);
  assert.match(wizardHtml, /id="model-id"/);
});
