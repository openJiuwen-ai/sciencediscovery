import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATA_DIR_MAX_LENGTH, DATA_DIR_WARN_LENGTH, defaultDataDir, ensureWritableDir,
  evaluateDataDir, formatBytes, freeBytesForPath, MIN_FREE_BYTES, probeDataDir,
} from "../src/wizard-data-dir.ts";

test("default: env override wins, then %LocalAppData%\\ScienceDiscovery (D5.2)", () => {
  assert.equal(defaultDataDir({ SCIENCE_DISCOVERY_DATA_DIR: "E:\\sd-data" }), "E:\\sd-data");
  assert.equal(
    defaultDataDir({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }),
    join("C:\\Users\\x\\AppData\\Local", "ScienceDiscovery"),
  );
  assert.ok(defaultDataDir({ USERPROFILE: "C:\\Users\\x" }).endsWith(".sciencediscovery"));
});

test("evaluate: healthy directory passes with no warnings", () => {
  const res = evaluateDataDir("C:\\Data\\SD", MIN_FREE_BYTES, true);
  assert.equal(res.ok, true);
  assert.equal(res.reason, undefined);
  assert.deepEqual(res.warnings, []);
  assert.equal(res.freeOk, true);
  assert.equal(res.pathLengthWarn, false);
});

test("evaluate: low disk blocks with a reason", () => {
  const res = evaluateDataDir("C:\\Data\\SD", 1024 ** 3, true);
  assert.equal(res.ok, false);
  assert.ok(res.reason?.includes("磁盘剩余空间不足"), res.reason);
  assert.equal(res.freeOk, false);
});

test("evaluate: unknown free space also blocks (fail closed)", () => {
  const res = evaluateDataDir("C:\\Data\\SD", null, true);
  assert.equal(res.ok, false);
});

test("evaluate: unwritable blocks", () => {
  const res = evaluateDataDir("C:\\Data\\SD", MIN_FREE_BYTES, false);
  assert.equal(res.ok, false);
  assert.ok(res.reason?.includes("不可写"), res.reason);
});

test("evaluate: path length warns at 180 and blocks past 240 (炸点③-17)", () => {
  const warnPath = "C:\\" + "a".repeat(DATA_DIR_WARN_LENGTH);
  assert.equal(warnPath.length, DATA_DIR_WARN_LENGTH + 3);
  const warned = evaluateDataDir(warnPath, MIN_FREE_BYTES, true);
  assert.equal(warned.ok, true, "180–240 is a warning, not a block");
  assert.equal(warned.pathLengthWarn, true);
  assert.ok(warned.warnings.some(w => w.includes("260")));

  const longPath = "C:\\" + "a".repeat(DATA_DIR_MAX_LENGTH);
  assert.ok(longPath.length > DATA_DIR_MAX_LENGTH);
  const blocked = evaluateDataDir(longPath, MIN_FREE_BYTES, true);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.pathTooLong, true);
  assert.ok(blocked.reason?.includes("路径过长"), blocked.reason);
});

test("freeBytesForPath: existing dir → positive; deep nonexistent path → ancestor's stat", () => {
  const free = freeBytesForPath(tmpdir());
  assert.ok(free !== null && free > 0, `expected positive free bytes, got ${free}`);
  const deep = freeBytesForPath(join(tmpdir(), "no-such-dir", "deeper", "deepest"));
  assert.ok(deep !== null && deep > 0);
});

test("ensureWritableDir: creates and proves writability; fails under a file", () => {
  const ud = mkdtempSync(join(tmpdir(), "sd-wizard-dir-"));
  const target = join(ud, "nested", "data");
  assert.equal(ensureWritableDir(target), true);
  assert.equal(ensureWritableDir(target), true, "idempotent on second call");

  const file = join(ud, "a-file");
  writeFileSync(file, "x", "utf8");
  assert.equal(ensureWritableDir(join(file, "sub")), false, "mkdir under a file must fail");
  rmSync(ud, { recursive: true, force: true });
});

test("probeDataDir: empty path fails fast with a reason", () => {
  const res = probeDataDir("   ");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "路径不能为空");
});

test("probeDataDir: real writable dir with disk space passes", () => {
  const ud = mkdtempSync(join(tmpdir(), "sd-wizard-probe-"));
  const res = probeDataDir(ud);
  assert.equal(res.ok, true, res.reason);
  assert.ok(res.freeBytes !== null && res.freeBytes > 0);
  rmSync(ud, { recursive: true, force: true });
});

test("formatBytes renders human units", () => {
  assert.equal(formatBytes(5 * 1024 ** 3), "5.0GB");
  assert.equal(formatBytes(200 * 1024 ** 2), "200MB");
  assert.equal(formatBytes(512 * 1024), "512KB");
});
