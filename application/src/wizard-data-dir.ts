// Data-directory page logic. Decisions are pure (unit-tested); the
// fs probes (statfs of the nearest existing ancestor, write probe) are thin.
import { mkdirSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { CURRENT_SHELL_PLATFORM } from "./shell-platform.ts";

/** Stack + venv provisioning + micromamba starter env reserve
 * (base ~700MB, provisioning headroom). Below this the wizard blocks. */
export const MIN_FREE_BYTES = 5 * 1024 ** 3;
/** LongPathsEnabled=0 keeps the 260-char MAX_PATH; deep venv paths
 * under the data dir have failed at ~265 chars. Warn past this… */
export const DATA_DIR_WARN_LENGTH = 180;
/** …and block outright when the root itself leaves no room at all. */
export const DATA_DIR_MAX_LENGTH = 240;

/**
 * Default data dir. win32: %LocalAppData%\ScienceDiscovery. darwin:
 * ~/Library/Application Support/ScienceDiscovery — the same folder
 * `app.getPath("userData")` resolves to, so the shell's window-state files
 * and the data dir live under one user-visible root without one being the
 * other's parent. An explicit SCIENCE_DISCOVERY_DATA_DIR (dev machines) is
 * preselected as-is on both platforms. Joins follow the TARGET platform's
 * dialect so injected branches produce native separators on any host.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv, platform: "win32" | "darwin" = CURRENT_SHELL_PLATFORM): string {
  const fromEnv = env.SCIENCE_DISCOVERY_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  if (platform === "darwin") {
    return posix.join(env.HOME ?? ".", "Library", "Application Support", "ScienceDiscovery");
  }
  if (env.LOCALAPPDATA?.trim()) return win32.join(env.LOCALAPPDATA, "ScienceDiscovery");
  return win32.join(env.USERPROFILE ?? ".", ".sciencediscovery");
}

export interface DataDirCheck {
  /** Bytes free on the target volume; null when unknown (probe failed). */
  freeBytes: number | null;
  freeOk: boolean;
  writable: boolean;
  pathLengthWarn: boolean;
  pathTooLong: boolean;
  /** The chosen dir overlaps the install root (see installRootCollision). */
  collidesWithInstall: boolean;
  ok: boolean;
  reason?: string;
  /** Human-facing summary lines for the wizard page. */
  warnings: string[];
}

/** Pure decision over the probe results. `installRoot` is the install dir the
 * uninstaller deletes unconditionally; null means "nothing to collide with"
 * (dev runs, where the shell lives in the repo) and skips that check.
 * The path-length gate is a Windows MAX_PATH concern: APFS caps a single
 * COMPONENT at 255 chars and has no 260 total limit, so on darwin neither
 * the warning nor the block fires (a too-long component surfaces from
 * Python itself with a clear error — there is nothing the wizard could
 * suggest anyway). */
export function evaluateDataDir(
  path: string,
  freeBytes: number | null,
  writable: boolean,
  installRoot: string | null = null,
  platform: "win32" | "darwin" = CURRENT_SHELL_PLATFORM,
): DataDirCheck {
  const warnings: string[] = [];
  const lengthChecked = platform === "win32";
  const pathTooLong = lengthChecked && path.length > DATA_DIR_MAX_LENGTH;
  const pathLengthWarn = lengthChecked && !pathTooLong && path.length > DATA_DIR_WARN_LENGTH;
  if (pathLengthWarn) {
    warnings.push(`路径较长（${path.length} 字符）：深层虚拟环境可能超过 Windows 260 字符限制，建议选择更短的目录`);
  }
  const freeOk = freeBytes === null ? false : freeBytes >= MIN_FREE_BYTES;
  if (freeBytes === null) {
    warnings.push("无法读取磁盘剩余空间");
  } else if (!freeOk) {
    warnings.push(`磁盘剩余空间不足（需要约 ${Math.round(MIN_FREE_BYTES / 1024 ** 3)}GB，当前 ${formatBytes(freeBytes)}）`);
  }
  const collision = installRootCollision(path, installRoot);
  const collidesWithInstall = collision.collides;
  if (collidesWithInstall) {
    // A warning line as well as the reason: the page lists warnings inline and
    // shows `reason` as the blocking explanation, so this has to reach both.
    warnings.push("数据目录与安装目录重合，卸载会连带删除数据");
  }
  let reason: string | undefined;
  // Collision outranks length but not the two hard prerequisites: "this exact
  // directory gets deleted" is more actionable than "it is a bit long", while
  // an unwritable or full volume is not something another path choice fixes.
  if (pathTooLong) reason = `路径过长（${path.length} 字符，上限 ${DATA_DIR_MAX_LENGTH}），Windows 260 字符限制下环境准备会失败`;
  else if (!freeOk) reason = "磁盘剩余空间不足，无法完成环境准备";
  // Antivirus interference is a real-world Windows failure mode (Defender
  // locking freshly-written venv files); on darwin it reads as noise — the
  // handful of real cases are permission- or disk-related.
  else if (!writable) reason = platform === "win32"
    ? "目录不可写（请检查权限或杀毒软件）"
    : "目录不可写（请检查权限）";
  else if (collidesWithInstall) reason = collision.reason;
  return {
    freeBytes, freeOk, writable, pathLengthWarn, pathTooLong, collidesWithInstall,
    ok: !pathTooLong && freeOk && writable && !collidesWithInstall,
    ...(reason ? { reason } : {}),
    warnings,
  };
}

/** statfs of the nearest existing ancestor — the target dir may not exist yet. */
export function freeBytesForPath(path: string): number | null {
  let current = path;
  while (true) {
    try {
      const stats = statfsSync(current);
      const free = Number(stats.bavail) * Number(stats.bsize);
      return Number.isFinite(free) && free >= 0 ? free : null;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * True only for a fully-qualified path. Rejects a bare drive letter (`E`) and
 * drive-relative forms (`E:tmp`), both of which `path.resolve` rebases onto the
 * process CWD — in the packaged app that is the INSTALL directory, so probing a
 * half-typed value would litter it with junk folders (problems W8).
 * `parse().root` is non-empty exactly for `C:\…` and UNC `\\server\share`.
 *
 * The win32 dialect is used EXPLICITLY, not the host one. What this function
 * answers is "is this a complete Windows path", and that answer must not depend
 * on which machine asked: with the host dialect a Linux runner says `false` for
 * `C:\Data\SD` (no `/` prefix), so the whole product rule was untestable off
 * Windows. win32.isAbsolute/win32.parse are fixed implementations — they return
 * the same verdict on every host, and they still accept POSIX shapes
 * (`/tmp`, `win32.parse("/tmp").root === "/"`), which is what the fs-probe
 * tests feed in from `tmpdir()` on a Linux runner. Verified against both
 * dialects over 13 shapes: win32 is right on all 13, the host dialect is wrong
 * on the two Windows ones off Windows.
 */
export function isFullyQualifiedPath(path: string): boolean {
  return win32.isAbsolute(path) && win32.parse(path).root !== "";
}

/**
 * Windows path identity for COMPARISON only: case-insensitive, with `/` folded
 * to `\` and trailing separators dropped. Deliberately string surgery rather
 * than `resolve`/`normalize` — both rebase a relative input onto the process
 * CWD, which in the packaged app is the install directory (problems W8).
 * Callers pass already-validated absolute paths; anything else simply compares
 * unequal instead of being silently rebased.
 *
 * A drive root normalizes to `c:` (the separator is stripped), which is why
 * isPathWithin below re-appends one to BOTH sides.
 */
export function comparePathKey(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** True when `child` is `parent` or sits anywhere below it. */
export function isPathWithin(child: string, parent: string): boolean {
  const c = comparePathKey(child);
  const p = comparePathKey(parent);
  if (!c || !p) return false;
  if (c === p) return true;
  // Separator appended to both sides, so `C:\users` is not "within" `C:\user`
  // and a drive root (`c:`) still works as a parent.
  return `${c}\\`.startsWith(`${p}\\`);
}

/**
 * Whether a data dir and the install root overlap — and why that is refused.
 *
 * The uninstall tail deletes $INSTDIR UNCONDITIONALLY (build/installer.nsh,
 * customUnInstall → DeleteFastThenHelper "$INSTDIR"), so a data dir inside the
 * install root loses envs/, secrets/ (model keys) and every session even when
 * the user leaves "also delete user data" unticked, contradicting the promise
 * the uninstall welcome page makes (MUI_UNWELCOMEPAGE_TEXT). That is problems
 * W16 — and it is precisely what the two DEFAULTS did before the install root
 * was renamed: defaultDataDir() above and the old customInit override were the
 * same literal, so the most common path through the product ("accept the
 * default") was the broken one.
 *
 * The mirror case is refused too: an install root inside the data dir means the
 * "delete user data" option would take the program with it, and the two trees
 * pollute each other either way (both own a logs/).
 *
 * `installRoot` is null when there is no install dir to collide with (dev runs,
 * where the shell lives in the repo), and then this always says no.
 */
export function installRootCollision(dataDir: string, installRoot: string | null): {
  collides: boolean;
  reason?: string;
} {
  if (!installRoot) return { collides: false };
  const data = comparePathKey(dataDir);
  const install = comparePathKey(installRoot);
  if (!data || !install) return { collides: false };
  if (data === install) {
    return {
      collides: true,
      reason: "数据目录不能与安装目录相同：卸载程序会无条件删除安装目录，运行环境与密钥会一并丢失",
    };
  }
  if (isPathWithin(dataDir, installRoot)) {
    return {
      collides: true,
      reason: "数据目录不能位于安装目录内：卸载程序会无条件删除安装目录，其中的数据（运行环境、密钥、会话）会一并丢失",
    };
  }
  if (isPathWithin(installRoot, dataDir)) {
    return {
      collides: true,
      reason: "安装目录不能位于数据目录内：卸载时勾选「同时删除用户数据」会连程序一起删除",
    };
  }
  return { collides: false };
}

/** Nearest existing ancestor of `path` — the dir itself when it exists.
 * Walks up like freeBytesForPath, because a probe of a half-typed path
 * must find SOME real dir to touch without creating any of the missing
 * middle segments (the mkdir-free probe discipline). Returns null only
 * for a fully-qualified path whose root does not exist (unmounted drive).
 *
 * The win32 dialect's dirname is used EXPLICITLY, matching the dialect
 * pinned by isFullyQualifiedPath: what this function answers is "where
 * does this WINDOWS path bottom out", and that answer must not depend on
 * which machine asked. With the host dialect a POSIX runner walks
 * `Q:\no\such\root` to `.` (host dirname of a non-POSIX path), stats the
 * process CWD successfully, and returns the CWD instead of null — both
 * failing the dead-root case and pointing probeWritableWithoutMkdir's
 * write at the CWD for a path that host cannot even resolve. win32.dirname
 * bottoms out at the drive root on every host (`Q:\` → `Q:\` → null)
 * while still walking POSIX shapes correctly (`/tmp/x` → `/tmp` → `/`),
 * because win32.dirname treats `/`-rooted paths as absolute too. */
export function nearestExistingDir(path: string): string | null {
  let current = path;
  while (true) {
    try {
      const stats = statSync(current);
      if (stats.isDirectory()) return current;
      // An ancestor exists but is a FILE: mkdir -p would fail ENOTDIR
      // here; report the ancestor so the probe writes into it and fails
      // with a truthful "not writable" instead of a silent wrong verdict.
      return current;
    } catch {
      const parent = win32.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** Read-only writability probe: proves the volume accepts writes WITHOUT
 * creating the target dir. The probe file lands in the nearest EXISTING
 * ancestor (see nearestExistingDir) and is deleted immediately — a
 * half-typed intermediate path therefore never mkdirs anything (the
 * 400ms-debounced input probe ran mkdirSync on every intermediate value;
 * typing `D:\ai\sd\data` left `D:\ai` and `D:\ai\sd` behind when the user
 * changed their mind mid-typing — the same litter class as problems W8,
 * which guarded the CWD, but on the user's own drives).
 *
 * The probe name carries the pid: the anchor is an arbitrary pre-existing
 * folder (the nearest existing ancestor, possibly a user folder), so a
 * fixed name could overwrite and delete a user file that happened to be
 * called the same thing (review note on the first cut of this helper).
 *
 * Weakening vs ensureWritableDir, accepted deliberately: "the target itself
 * is occupied by a file" is not discovered until confirm time — where
 * ensureWritableDir mkdirs and fails with a truthful error. The check-page
 * verdict on that case reads "not writable" via the ENOTDIR ancestor below.
 */
export function probeWritableWithoutMkdir(path: string): boolean {
  if (!isFullyQualifiedPath(path)) return false;
  const anchor = nearestExistingDir(path);
  if (anchor === null) return false;
  const probe = join(anchor, `.sd-wizard-probe-${process.pid}`);
  try {
    writeFileSync(probe, "ok");
    rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Create the dir (idempotent) and prove it accepts writes.
 * CONFIRM-TIME ONLY: this is the primitive behind wizard-confirm-dir —
 * the input-time probe must never reach it (probeWritableWithoutMkdir
 * instead). Kept side-effecting by design: creating the chosen dir IS
 * the confirmed action. */
export function ensureWritableDir(path: string): boolean {
  // Self-defence: this is a side-effecting helper other callers may reach
  // without going through probeDataDir's validation. Never mkdir a relative
  // or drive-relative path — it would resolve under the CWD (problems W8).
  if (!isFullyQualifiedPath(path)) return false;
  try {
    mkdirSync(path, { recursive: true });
    // Pid-suffixed for the same reason as probeWritableWithoutMkdir's: the
    // dir may pre-exist as a user folder, and the probe must not clobber a
    // user file that happens to carry the fixed name.
    const probe = join(path, `.sd-wizard-probe-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Thin IO wrapper the main process calls on the wizard page's behalf.
 * `installRoot` is the install dir the data dir must stay clear of (see
 * installRootCollision); pass null in dev, where there is no install dir. */
export function probeDataDir(
  path: string,
  installRoot: string | null = null,
  platform: "win32" | "darwin" = CURRENT_SHELL_PLATFORM,
): DataDirCheck {
  const clean = path.trim();
  if (!clean) {
    return {
      freeBytes: null, freeOk: false, writable: false, pathLengthWarn: false, pathTooLong: false,
      collidesWithInstall: false,
      ok: false, reason: "路径不能为空", warnings: [],
    };
  }
  // Validate absoluteness BEFORE any fs probe: a half-typed `E` or `E:tmp`
  // must not reach mkdirSync (problems W8 — it created <installDir>\E).
  if (!isFullyQualifiedPath(clean)) {
    return {
      freeBytes: null, freeOk: false, writable: false, pathLengthWarn: false, pathTooLong: false,
      collidesWithInstall: false,
      ok: false, reason: "请输入完整路径（例如 D:\\data）", warnings: [],
    };
  }
  // And decide the collision BEFORE any write probe: probeWritableWithoutMkdir
  // drops a temp file in the nearest existing dir, so probing the install dir
  // itself would litter it — the same class of mistake as problems W8.
  const collision = installRootCollision(clean, installRoot);
  if (collision.collides) {
    return {
      freeBytes: null, freeOk: false, writable: false, pathLengthWarn: false, pathTooLong: false,
      collidesWithInstall: true,
      ok: false, reason: collision.reason, warnings: [],
    };
  }
  // Read-only writability probe: the 400ms-debounced input probe runs on
  // HALF-TYPED values, so this must never mkdir the target (see
  // probeWritableWithoutMkdir). Directory creation belongs to confirm time
  // (wizard-confirm-dir → ensureWritableDir) only.
  return evaluateDataDir(clean, freeBytesForPath(clean), probeWritableWithoutMkdir(clean), installRoot, platform);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)}MB`;
  return `${Math.max(0, Math.round(bytes / 1024))}KB`;
}
