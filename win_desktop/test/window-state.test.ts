import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWindowState, saveWindowState } from "../src/window-state.ts";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sd-shell-test-"));
  dirs.push(d);
  return d;
}
process.on("exit", () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("missing state file yields the default bounds", () => {
  const s = loadWindowState(tempDir());
  assert.deepEqual(s, { width: 1440, height: 900 });
});

test("corrupt state file yields the default bounds", () => {
  const d = tempDir();
  saveWindowState(d, { width: 1280, height: 800, x: 10, y: 20, maximized: true });
  const s = loadWindowState(d);
  assert.deepEqual(s, { width: 1280, height: 800, x: 10, y: 20, maximized: true });
});

test("garbage content falls back to default", () => {
  const d = tempDir();
  writeFileSync(join(d, "window-state.json"), "not json {", "utf8");
  assert.deepEqual(loadWindowState(d), { width: 1440, height: 900 });
});

test("absurd sizes are rejected (main-monitor sanity floor)", () => {
  const d = tempDir();
  saveWindowState(d, { width: 100, height: 100 });
  assert.deepEqual(loadWindowState(d), { width: 1440, height: 900 });
});
