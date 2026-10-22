// Data-directory page logic (F8.2). Decisions are pure (unit-tested); the
// fs probes (statfs of the nearest existing ancestor, write probe) are thin.
import { mkdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Stack + venv provisioning + micromamba starter env reserve (D1.x/D5.2:
 * base ~700MB, provisioning headroom). Below this the wizard blocks. */
export const MIN_FREE_BYTES = 5 * 1024 ** 3;
/** 炸点③-17: LongPathsEnabled=0 keeps the 260-char MAX_PATH; deep venv paths
 * under the data dir have failed at ~265 chars. Warn past this… */
export const DATA_DIR_WARN_LENGTH = 180;
/** …and block outright when the root itself leaves no room at all. */
export const DATA_DIR_MAX_LENGTH = 240;

/**
 * Default per D5.2 (Provider A → Windows side): %LocalAppData%\ScienceDiscovery.
 * An explicit SCIENCE_DISCOVERY_DATA_DIR (dev machines) is preselected as-is.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.SCIENCE_DISCOVERY_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  if (env.LOCALAPPDATA?.trim()) return join(env.LOCALAPPDATA, "ScienceDiscovery");
  return join(env.USERPROFILE ?? ".", ".sciencediscovery");
}

export interface DataDirCheck {
  /** Bytes free on the target volume; null when unknown (probe failed). */
  freeBytes: number | null;
  freeOk: boolean;
  writable: boolean;
  pathLengthWarn: boolean;
  pathTooLong: boolean;
  ok: boolean;
  reason?: string;
  /** Human-facing summary lines for the wizard page. */
  warnings: string[];
}

/** Pure decision over the probe results. */
export function evaluateDataDir(path: string, freeBytes: number | null, writable: boolean): DataDirCheck {
  const warnings: string[] = [];
  const pathTooLong = path.length > DATA_DIR_MAX_LENGTH;
  const pathLengthWarn = !pathTooLong && path.length > DATA_DIR_WARN_LENGTH;
  if (pathLengthWarn) {
    warnings.push(`路径较长（${path.length} 字符）：深层虚拟环境可能超过 Windows 260 字符限制，建议选择更短的目录`);
  }
  const freeOk = freeBytes === null ? false : freeBytes >= MIN_FREE_BYTES;
  if (freeBytes === null) {
    warnings.push("无法读取磁盘剩余空间");
  } else if (!freeOk) {
    warnings.push(`磁盘剩余空间不足（需要约 ${Math.round(MIN_FREE_BYTES / 1024 ** 3)}GB，当前 ${formatBytes(freeBytes)}）`);
  }
  let reason: string | undefined;
  if (pathTooLong) reason = `路径过长（${path.length} 字符，上限 ${DATA_DIR_MAX_LENGTH}），Windows 260 字符限制下环境准备会失败`;
  else if (!freeOk) reason = "磁盘剩余空间不足，无法完成环境准备";
  else if (!writable) reason = "目录不可写（请检查权限或杀毒软件）";
  return {
    freeBytes, freeOk, writable, pathLengthWarn, pathTooLong,
    ok: !pathTooLong && freeOk && writable,
    ...(reason ? { reason } : {}),
    warnings,
  };
}

/** statfs of the nearest existing ancestor — the target dir may not exist yet. */
export function freeBytesForPath(path: string): number | null {
  let current = path;
  for (;;) {
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

/** Create the dir (idempotent) and prove it accepts writes. */
export function ensureWritableDir(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true });
    const probe = join(path, ".sd-wizard-probe");
    writeFileSync(probe, "ok");
    rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Thin IO wrapper the main process calls on the wizard page's behalf. */
export function probeDataDir(path: string): DataDirCheck {
  const clean = path.trim();
  if (!clean) {
    return {
      freeBytes: null, freeOk: false, writable: false, pathLengthWarn: false, pathTooLong: false,
      ok: false, reason: "路径不能为空", warnings: [],
    };
  }
  return evaluateDataDir(clean, freeBytesForPath(clean), ensureWritableDir(clean));
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)}MB`;
  return `${Math.max(0, Math.round(bytes / 1024))}KB`;
}
