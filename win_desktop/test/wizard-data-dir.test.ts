import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  comparePathKey, DATA_DIR_MAX_LENGTH, DATA_DIR_WARN_LENGTH, defaultDataDir,
  ensureWritableDir, evaluateDataDir, formatBytes, freeBytesForPath,
  installRootCollision, isFullyQualifiedPath, isPathWithin, MIN_FREE_BYTES,
  probeDataDir,
} from "../src/wizard-data-dir.ts";

// Two notes on the host-independence of this file. It ships in win_desktop, but
// nothing here assumes the runner is Windows: the pure cases spell Windows
// paths as literals because that is the dialect the product parses (and since
// isFullyQualifiedPath uses path.win32 explicitly, those literals mean the same
// thing on every host), while every case that TOUCHES the filesystem builds its
// paths from tmpdir() so a Linux runner probes /tmp instead of C:\.

test("default: env override wins, then %LocalAppData%\\ScienceDiscovery", () => {
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

test("evaluate: path length warns at 180 and blocks past 240", () => {
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

// problems W8: a half-typed value must never reach mkdirSync, or it resolves
// under the packaged CWD (the install dir) and litters it with junk folders.
test("isFullyQualifiedPath: accepts C:\\… and UNC, rejects bare/relative/drive-relative", () => {
  assert.equal(isFullyQualifiedPath("C:\\Data\\SD"), true);
  assert.equal(isFullyQualifiedPath("E:\\tmp"), true);
  assert.equal(isFullyQualifiedPath("E:/tmp"), true, "forward-slash absolute is fine");
  assert.equal(isFullyQualifiedPath("\\\\server\\share"), true, "UNC root is qualified");
  assert.equal(isFullyQualifiedPath("E"), false, "bare drive letter is drive-relative");
  assert.equal(isFullyQualifiedPath("E:tmp"), false, "drive-relative without root");
  assert.equal(isFullyQualifiedPath("tmp"), false, "plain relative");
  assert.equal(isFullyQualifiedPath(""), false);
});

test("probeDataDir: rejects non-absolute input before any fs probe", () => {
  for (const bad of ["E", "E:tmp", "tmp", "nested\\deeper"]) {
    const res = probeDataDir(bad);
    assert.equal(res.ok, false, `${bad} must be blocked`);
    assert.equal(res.reason, "请输入完整路径（例如 D:\\data）", `${bad}: ${res.reason}`);
    assert.equal(res.writable, false);
    assert.deepEqual(res.warnings, []);
  }
});

test("ensureWritableDir: never mkdirs a relative/drive-relative path", () => {
  // These would resolve under the CWD; the guard must short-circuit to false
  // WITHOUT touching the filesystem (no junk dir created in the repo root).
  assert.equal(ensureWritableDir("E"), false);
  assert.equal(ensureWritableDir("E:tmp"), false);
  assert.equal(ensureWritableDir("sd-wizard-should-not-exist"), false);
});

test("probeDataDir: real writable dir with disk space passes", () => {
  const ud = mkdtempSync(join(tmpdir(), "sd-wizard-probe-"));
  const res = probeDataDir(ud);
  assert.equal(res.ok, true, res.reason);
  assert.ok(res.freeBytes !== null && res.freeBytes > 0);
  rmSync(ud, { recursive: true, force: true });
});

test("comparePathKey: folds case, separators and trailing separators", () => {
  // The comparison identity behind installRootCollision. Windows treats these
  // as one path, so the gate must too — otherwise a user could walk around it
  // by changing a letter case or a slash direction.
  assert.equal(comparePathKey("C:\\Data\\SD"), "c:\\data\\sd");
  assert.equal(comparePathKey("C:/Data/SD"), "c:\\data\\sd", "forward slashes fold");
  assert.equal(comparePathKey("C:\\Data\\SD\\"), "c:\\data\\sd", "trailing separator drops");
  assert.equal(comparePathKey("C:\\Data\\SD\\\\"), "c:\\data\\sd", "repeated trailing separators");
  assert.equal(comparePathKey("C:\\Data\\SD"), comparePathKey("c:\\DATA\\Sd"), "case-insensitive");
  // A drive root loses its separator, which is why isPathWithin re-appends one.
  assert.equal(comparePathKey("C:\\"), "c:");
});

test("isPathWithin: parent, self and prefix near-misses", () => {
  assert.equal(isPathWithin("C:\\Data\\SD", "C:\\Data\\SD"), true, "a path is within itself");
  assert.equal(isPathWithin("C:\\Data\\SD\\envs", "C:\\Data\\SD"), true);
  assert.equal(isPathWithin("C:\\Data\\SD\\a\\b\\c", "C:\\Data\\SD"), true, "any depth");
  assert.equal(isPathWithin("C:\\data\\sd\\envs", "C:\\DATA\\SD"), true, "case-insensitive");
  assert.equal(isPathWithin("C:/Data/SD/envs", "C:\\Data\\SD"), true, "mixed separators");

  // The failure mode a naive startsWith would have: a sibling that merely
  // shares a text prefix is NOT within.
  assert.equal(isPathWithin("C:\\Data\\SDX", "C:\\Data\\SD"), false, "prefix, not a child");
  assert.equal(isPathWithin("C:\\Data\\SD-App", "C:\\Data\\SD"), false);
  assert.equal(isPathWithin("C:\\Data\\SD", "C:\\Data\\SD\\envs"), false, "parent is not within child");
  assert.equal(isPathWithin("D:\\Data\\SD", "C:\\Data\\SD"), false, "different volume");
  assert.equal(isPathWithin("C:\\Data\\SD", ""), false, "empty parent is not a wildcard");
  assert.equal(isPathWithin("", "C:\\Data"), false);

  // A drive root still works as a parent even though comparePathKey strips its
  // separator (c:\ → c:) — that is what re-appending to BOTH sides buys.
  assert.equal(isPathWithin("C:\\anything\\at\\all", "C:\\"), true);
  assert.equal(isPathWithin("D:\\anything", "C:\\"), false);
});

// problems W16: the install root and the data dir must never overlap, because
// the uninstall tail deletes $INSTDIR unconditionally (installer.nsh
// customUnInstall → DeleteFastThenHelper "$INSTDIR") regardless of whether the
// user ticked "also delete user data". Before the install root was renamed the
// two DEFAULTS were the same literal, so accepting the wizard default meant
// uninstalling destroyed envs/, secrets/ and every session.
test("installRootCollision: refuses equal, nested and enclosing", () => {
  const install = "C:\\Users\\me\\AppData\\Local\\ScienceDiscoveryApp";
  const data = "C:\\Users\\me\\AppData\\Local\\ScienceDiscovery";

  // The two defaults must now be disjoint — this is the regression the rename
  // in installer.nsh exists for.
  assert.equal(installRootCollision(data, install).collides, false,
    "the renamed install root no longer collides with the default data dir");

  const same = installRootCollision(install, install);
  assert.equal(same.collides, true);
  assert.ok(same.reason?.includes("不能与安装目录相同"), same.reason);

  // A user typing a subdir of the install dir reproduces W16 by hand.
  const nested = installRootCollision(`${install}\\envs`, install);
  assert.equal(nested.collides, true);
  assert.ok(nested.reason?.includes("位于安装目录内"), nested.reason);

  // The mirror case: installing INTO the data dir means the "delete user data"
  // option takes the program with it.
  const mirrored = installRootCollision(data, `${data}\\App`);
  assert.equal(mirrored.collides, true);
  assert.ok(mirrored.reason?.includes("位于数据目录内"), mirrored.reason);

  // Windows case/separator equivalence must not be walkable-around.
  assert.equal(installRootCollision("c:/users/me/appdata/local/sciencediscoveryapp/",
    "C:\\Users\\me\\AppData\\Local\\ScienceDiscoveryApp").collides, true);
});

test("installRootCollision: no install root means nothing to collide with", () => {
  // Dev runs (main.ts installRootForWizard returns null when !app.isPackaged):
  // the shell lives in the repo, so any data dir is fine.
  assert.equal(installRootCollision("C:\\Data\\SD", null).collides, false);
  assert.equal(installRootCollision("C:\\Data\\SD", null).reason, undefined);
  // Sibling trees are fine too, on the same volume or a different one.
  assert.equal(installRootCollision("C:\\Data\\SD", "C:\\Programs\\SD").collides, false);
  assert.equal(installRootCollision("D:\\Data\\SD", "C:\\Programs\\SD").collides, false);
});

test("evaluateDataDir: a colliding dir blocks even when it is writable with room", () => {
  const install = "C:\\Apps\\ScienceDiscoveryApp";
  const res = evaluateDataDir(`${install}\\envs`, MIN_FREE_BYTES, true, install);
  assert.equal(res.ok, false, "collision must block");
  assert.equal(res.collidesWithInstall, true);
  assert.ok(res.reason?.includes("位于安装目录内"), res.reason);
  assert.ok(res.warnings.some(w => w.includes("重合")), JSON.stringify(res.warnings));
  // freeOk/writable stay true: the block is the collision alone, so the page
  // shows the actionable reason instead of a misleading disk-space one.
  assert.equal(res.freeOk, true);
  assert.equal(res.writable, true);
});

test("evaluateDataDir: reason precedence keeps the fixable message last", () => {
  const install = "C:\\Apps\\ScienceDiscoveryApp";
  const colliding = `${install}\\envs`;
  // Unwritable outranks the collision: no path choice fixes a permission
  // problem, so saying "pick another dir" would send the user nowhere.
  const unwritable = evaluateDataDir(colliding, MIN_FREE_BYTES, false, install);
  assert.equal(unwritable.ok, false);
  assert.equal(unwritable.collidesWithInstall, true);
  assert.ok(unwritable.reason?.includes("不可写"), unwritable.reason);
  // A too-long path outranks the collision for the same reason, and the length
  // check is what actually predicts a broken environment.
  const longColliding = `${install}\\${"a".repeat(DATA_DIR_MAX_LENGTH)}`;
  const long = evaluateDataDir(longColliding, MIN_FREE_BYTES, true, install);
  assert.equal(long.pathTooLong, true);
  assert.ok(long.reason?.includes("路径过长"), long.reason);
  // …but a healthy colliding dir reports the collision.
  assert.ok(evaluateDataDir(colliding, MIN_FREE_BYTES, true, install).reason?.includes("安装目录"));
});

test("evaluateDataDir: without an install root nothing changes", () => {
  // The default parameter must keep every pre-W16 caller's verdict identical.
  const res = evaluateDataDir("C:\\Data\\SD", MIN_FREE_BYTES, true);
  assert.equal(res.ok, true);
  assert.equal(res.collidesWithInstall, false);
  assert.deepEqual(res.warnings, []);
});

test("probeDataDir: refuses the install dir before touching the filesystem", () => {
  // Order matters and is the point of this case: ensureWritableDir mkdirs and
  // writes a probe file, so a collision verdict reached afterwards would have
  // already littered the install dir (the same class of mistake as problems W8).
  // The tmpdir()-rooted paths keep this host-independent (see the note at the
  // top of this file); the assertion is about the early return, not about the
  // volume having 5GB free.
  const install = join(tmpdir(), "sd-install-root-must-stay-empty");
  rmSync(install, { recursive: true, force: true });
  mkdirSync(install, { recursive: true });
  try {
    const res = probeDataDir(join(install, "data"), install);
    assert.equal(res.ok, false);
    assert.equal(res.collidesWithInstall, true);
    assert.equal(res.writable, false, "the write probe must not have run");
    assert.equal(res.freeBytes, null, "no statfs either — it returned early");
    assert.equal(existsSync(join(install, "data")), false,
      "the colliding dir must not have been created");
  } finally {
    rmSync(install, { recursive: true, force: true });
  }
});

test("probeDataDir: a clear sibling dir is not blocked by the install-root gate", () => {
  const ud = mkdtempSync(join(tmpdir(), "sd-wizard-clear-"));
  const install = join(tmpdir(), "sd-wizard-install-sibling");
  mkdirSync(install, { recursive: true });
  try {
    const res = probeDataDir(ud, install);
    assert.equal(res.collidesWithInstall, false);
    assert.ok(res.freeBytes !== null, "statfs ran, so the probes were reached");
    // ok can still be false on a host whose temp volume has under
    // MIN_FREE_BYTES free — that is the disk gate, not this one, so the
    // collision verdict above is the only thing asserted.
  } finally {
    rmSync(ud, { recursive: true, force: true });
    rmSync(install, { recursive: true, force: true });
  }
});
test("formatBytes renders human units", () => {
  assert.equal(formatBytes(5 * 1024 ** 3), "5.0GB");
  assert.equal(formatBytes(200 * 1024 ** 2), "200MB");
  assert.equal(formatBytes(512 * 1024), "512KB");
});
