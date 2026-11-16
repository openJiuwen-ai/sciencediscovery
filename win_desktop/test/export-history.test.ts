import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPORT_HISTORY_LIMIT, ExportHistoryStore, loadExportHistory } from "../src/export-history.ts";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sd-export-history-"));
  dirs.push(d);
  return d;
}
process.on("exit", () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    bytes: 1024,
    filename: `${id}.sdresearch`,
    id,
    path: `C:\\Users\\me\\Downloads\\${id}.sdresearch`,
    savedAt: "2026-11-16T00:00:00.000Z",
    token: `token-${id}`,
    ...over,
  };
}

test("a missing history file reads as an empty list", () => {
  assert.deepEqual(loadExportHistory(tempDir()), []);
});

test("a corrupt history file reads as an empty list rather than throwing", () => {
  const d = tempDir();
  writeFileSync(join(d, "export-history.json"), "not json {", "utf8");
  assert.deepEqual(loadExportHistory(d), []);
  assert.deepEqual(new ExportHistoryStore(d).list(), []);
});

test("a finished export is recorded and survives a new store (the restart case)", () => {
  const d = tempDir();
  const store = new ExportHistoryStore(d);
  store.record(row("task-1", { level: "complete", sessionId: "s1", sessionTitle: "晶体结构分析" }));
  const reopened = new ExportHistoryStore(d);
  const rows = reopened.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "task-1");
  assert.equal(rows[0]!.token, "token-task-1");
  assert.equal(rows[0]!.level, "complete");
  assert.equal(rows[0]!.sessionTitle, "晶体结构分析");
  assert.equal(reopened.byToken("token-task-1")?.path, row("task-1").path);
});

test("re-saving the same task updates its row instead of adding one", () => {
  const d = tempDir();
  const store = new ExportHistoryStore(d);
  store.record(row("task-1"));
  store.record(row("task-1", { bytes: 2048, token: "token-new", path: "D:\\elsewhere.sdresearch", savedAt: "2026-11-16T01:00:00.000Z" }));
  const rows = new ExportHistoryStore(d).list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.token, "token-new");
  assert.equal(rows[0]!.bytes, 2048);
  assert.equal(rows[0]!.path, "D:\\elsewhere.sdresearch");
  assert.equal(store.byToken("token-task-1"), undefined);
});

test("rows stay newest first and the oldest fall off the bound", () => {
  const d = tempDir();
  const store = new ExportHistoryStore(d, 3);
  store.record(row("a", { savedAt: "2026-11-01T00:00:00.000Z" }));
  store.record(row("b", { savedAt: "2026-11-02T00:00:00.000Z" }));
  store.record(row("c", { savedAt: "2026-11-03T00:00:00.000Z" }));
  store.record(row("d", { savedAt: "2026-11-04T00:00:00.000Z" }));
  const rows = new ExportHistoryStore(d, 3).list();
  assert.deepEqual(rows.map((entry) => entry.id), ["d", "c", "b"]);
  assert.equal(EXPORT_HISTORY_LIMIT, 200);
});

test("forget drops the row, keeps the rest, and reports whether it was there", () => {
  const d = tempDir();
  const store = new ExportHistoryStore(d);
  store.record(row("a"));
  store.record(row("b"));
  assert.equal(store.forget("a"), true);
  assert.equal(store.forget("a"), false);
  assert.deepEqual(new ExportHistoryStore(d).list().map((entry) => entry.id), ["b"]);
});

test("rows missing an identity are dropped on load instead of leaking into the list", () => {
  const d = tempDir();
  writeFileSync(join(d, "export-history.json"), JSON.stringify({
    records: [
      { id: "", token: "t", path: "p", filename: "f", bytes: 1, savedAt: "2026-11-16T00:00:00.000Z" },
      { id: "ok", token: "t2", path: "p2", filename: "f2", bytes: 2, savedAt: "2026-11-16T00:00:00.000Z" },
      { id: "no-path", token: "t3", filename: "f3", bytes: 3, savedAt: "2026-11-16T00:00:00.000Z" },
    ],
    version: 1,
  }), "utf8");
  assert.deepEqual(loadExportHistory(d).map((entry) => entry.id), ["ok"]);
});
