import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeSourcesForCategories } from "../test/support/tagged/shared.mjs";
import { createTest } from "../test/support/tagged/compat.mjs";
import { comparePlans, planIdentitySet } from "./plan-stability.mjs";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"],
});

test("shared Node collection includes the category slices and ignores standalone tests", t => {
  const root = mkdtempSync(join(tmpdir(), "plan-stability-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const desktop = "apps/desktop/tests";
  mkdirSync(join(root, desktop), { recursive: true });
  mkdirSync(join(root, "test/api"), { recursive: true });
  writeFileSync(join(root, "test/api/agent_loop_smoke.ts"), '// "category:st"');
  writeFileSync(join(root, desktop, "standalone.test.ts"), 'import { test } from "node:test";');
  for (const category of ["ut", "st", "e2e"]) {
    writeFileSync(join(root, desktop, `${category}.test.ts`), `// "category:${category}"`);
  }
  const sources = categories => nodeSourcesForCategories(categories, root).map(file => file.replaceAll("\\", "/"));
  assert.deepEqual(sources(["ut", "st", "e2e"]), [
    `${desktop}/e2e.test.ts`, `${desktop}/st.test.ts`, `${desktop}/ut.test.ts`, "test/api/agent_loop_smoke.ts",
  ]);
  assert.deepEqual(sources(["ut"]), [`${desktop}/ut.test.ts`]);
});

test("plan stability compares revision, catalog, digest and identity set", () => {
  const first = {
    revision: "abc",
    catalogDigest: "catalog-a",
    digest: "plan-a",
    entries: [{ key: "one" }, { key: "two" }],
  };
  const same = {
    revision: "abc",
    catalogDigest: "catalog-a",
    digest: "plan-a",
    entries: [{ key: "two" }, { key: "one" }],
  };
  assert.deepEqual(planIdentitySet(first), ["one", "two"]);
  assert.deepEqual(comparePlans(first, same), []);
  assert.deepEqual(comparePlans(first, { ...same, digest: "plan-b" }), ["plan digest changed"]);
  assert.deepEqual(comparePlans(first, { ...same, digest: "plan-b", entries: [{ key: "one" }, { key: "three" }] }), ["plan digest changed", "plan identity set changed"]);
});
