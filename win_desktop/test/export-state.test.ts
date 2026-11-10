import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExportState, saveExportState } from "../src/export-state.ts";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sd-shell-test-"));
  dirs.push(d);
  return d;
}
process.on("exit", () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("missing state file yields null", () => {
  assert.equal(loadExportState(tempDir()), null);
});

test("saved directory round-trips", () => {
  const d = tempDir();
  saveExportState(d, { lastExportDir: "C:\\Users\\me\\Downloads" });
  assert.deepEqual(loadExportState(d), { lastExportDir: "C:\\Users\\me\\Downloads" });
});

test("garbage content falls back to null", () => {
  const d = tempDir();
  writeFileSync(join(d, "export-state.json"), "not json {", "utf8");
  assert.equal(loadExportState(d), null);
});

test("blank directory is treated as absent", () => {
  const d = tempDir();
  saveExportState(d, { lastExportDir: "   " });
  assert.equal(loadExportState(d), null);
});