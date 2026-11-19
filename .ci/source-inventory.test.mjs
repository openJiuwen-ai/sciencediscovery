import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSourceInventory } from "./source-inventory.mjs";
import { createTest } from "../test/support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });

test("source inventory scans behavioral source roots and reports unmapped files", async () => {
  const inventory = await buildSourceInventory();
  assert.ok(inventory.length > 100, `expected broad source inventory, got ${inventory.length}`);
  const router = inventory.find((entry) => entry.source === "services/api/src/http/index.ts");
  assert.equal(router?.classification, "behavioral");
  assert.equal(router?.risk, "P0");
  assert.ok(inventory.some((entry) => entry.source === "services/api/src/trajectory.ts" && entry.mapped));
  assert.ok(inventory.some((entry) => entry.source === "services/runner/src/agent-execution.ts" && entry.mapped));
  assert.ok(inventory.every((entry) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.source)));
  assert.ok(inventory.some((entry) => entry.source === "apps/web/src/MemoryGraphCanvas.tsx" && entry.mapped));
  assert.ok(inventory.some((entry) => !entry.mapped && entry.classification === "behavioral"));
  assert.ok(inventory.every((entry) => entry.source === entry.source.replaceAll("\\", "/")));
});

test("source inventory distinguishes declarations, re-exports and executable code", async t => {
  const root = await mkdtemp(join(tmpdir(), "source-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = "services/api/src/http";
  await mkdir(join(root, dir), { recursive: true });
  await mkdir(join(root, "test"));
  await writeFile(join(root, "test/source-test-map.json"), '{"version":1,"entries":[]}');
  const fixtures = [
    ["contract.ts", "export type Handler = () => void;", "structural-or-type-only"],
    ["barrel.ts", 'export * from "./contract.js";', "structural-or-type-only"],
    ["constants.ts", "export const DEFAULT_PORT = 4321;", "behavioral"],
    ["index.ts", 'import "./register.js"; export * from "./contract.js";', "behavioral"],
    ["incomplete.ts", "export interface {", "behavioral"],
  ];
  for (const [name, content] of fixtures) await writeFile(join(root, dir, name), content);
  const inventory = await buildSourceInventory(root);
  assert.deepEqual(new Map(inventory.map(entry => [entry.source, entry.classification])),
    new Map(fixtures.map(([name, , classification]) => [`${dir}/${name}`, classification])));
});
