import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSourceInventory } from "./source-inventory.mjs";
import { createTest } from "../test/support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });

test("source inventory scans behavioral source roots and reports unmapped files", async () => {
  const inventory = await buildSourceInventory();
  assert.ok(inventory.length > 100, `expected broad source inventory, got ${inventory.length}`);
  assert.ok(inventory.some((entry) => entry.source === "services/api/src/http/index.ts"));
  assert.ok(inventory.some((entry) => entry.source === "apps/web/src/MemoryGraphCanvas.tsx" && entry.mapped));
  assert.ok(inventory.some((entry) => !entry.mapped && entry.classification === "behavioral"));
  assert.ok(inventory.every((entry) => entry.source === entry.source.replaceAll("\\", "/")));
});

test("source inventory keeps type-only files visible without treating them as missing behavior evidence", async () => {
  const inventory = await buildSourceInventory();
  const typeOnly = inventory.filter((entry) => entry.classification === "structural-or-type-only");
  assert.ok(typeOnly.length > 0);
  assert.ok(typeOnly.every((entry) => entry.classification === "structural-or-type-only"));
});
