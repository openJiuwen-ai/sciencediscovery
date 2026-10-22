// F10.6e: map start-stack / bootstrap output lines to loading-page stages.
// Pure string → stage mapping so the loading page can show "正在启动 XX…"
// instead of a blank window while the backend cold-starts.
//
// Sources of lines (all already piped through the shell's log()):
//   - start-stack.mjs `say()` → stderr → spawnStack prefixes "[stack:err] "
//   - bootstrap.ts first-run provisioning → "[sd-shell] first run: ..."

export interface LoadingStage {
  stage: string;
  text: string;
}

/** Ordered progress map: stage key → user-facing text. */
export const STAGE_TEXTS: Record<string, string> = {
  connect: "正在连接后端…",
  unpack: "正在准备运行环境（仅首次，约 1 分钟）…",
  // "precompile" is the rare fallback path (payload shipped cache-less);
  // normal installs skip it because the build precompiled everything.
  precompile: "正在预编译 Python 字节码（仅首次，可加快后续启动）…",
  stack: "正在启动服务栈…",
  runner: "正在启动运行器…",
  "memory-graph": "正在启动记忆图服务…",
  evolve: "正在启动演化服务…",
  jiuwenswarm: "正在启动智能体集群（组件较大，可能需要几分钟）…",
  adapter: "正在启动协议适配器…",
  api: "正在启动主服务，即将就绪…",
};

/** Daily cold-start sequence (no provisioning stages). */
export const STAGE_SEQUENCE = ["connect", "stack", "runner", "memory-graph", "evolve", "jiuwenswarm", "adapter", "api"] as const;
/**
 * First-run-only stages. Bytecode precompiling moved to build time
 * (assemble-backend.mjs ships __pycache__ with content-hash invalidation), so
 * the normal first run is just the unpack; "precompile" stays a valid stage
 * key for the fallback path but no longer occupies a numbered step.
 */
export const FIRST_RUN_STAGES = ["unpack"] as const;

/**
 * Rough per-stage seconds (SSD-class) for the "≈Xs left" hint. F10.6d2
 * estimates: unpack runs a 16-way concurrent copy; the build-time precompile
 * made the first-run compile step a no-op.
 */
export const STAGE_ESTIMATE_SEC: Record<string, number> = {
  connect: 1,
  unpack: 60,
  precompile: 55,
  stack: 1,
  runner: 2,
  "memory-graph": 4,
  evolve: 5,
  // F10.6 calibration: dev machine measured jw at 54s to come up (the old 10s
  // exhausted the countdown and looked frozen); cold/AV machines run longer —
  // the wait-loop progress lines keep the text alive meanwhile.
  jiuwenswarm: 60,
  adapter: 4,
  api: 5,
};

/** 1-based step number, total steps, and remaining-seconds estimate. */
export function stageProgress(stage: string, firstRun: boolean): { current: number; total: number; estimateSec: number } {
  const seq: string[] = firstRun ? [...FIRST_RUN_STAGES, ...STAGE_SEQUENCE] : [...STAGE_SEQUENCE];
  const idx = seq.indexOf(stage);
  if (idx < 0) return { current: 0, total: seq.length, estimateSec: 0 };
  const estimateSec = seq.slice(idx).reduce((sum, s) => sum + (STAGE_ESTIMATE_SEC[s] ?? 0), 0);
  return { current: idx + 1, total: seq.length, estimateSec };
}

/** say() literals from scripts/start-stack.mjs (contract with the stack script). */
const STACK_LINES: Array<[RegExp, string]> = [
  [/Starting the sandbox runner daemon/, "runner"],
  [/Starting the memory-graph service/, "memory-graph"],
  [/Starting the evolve service/, "evolve"],
  [/JiuwenSwarm is not running; starting it/, "jiuwenswarm"],
  [/Starting the adapter on port/, "adapter"],
  [/Starting the control API/, "api"],
];

/**
 * Parse one shell log line into a loading stage, or null when it carries no
 * stage information (the common case — service logs, warnings, etc.).
 * Never throws: unknown lines are simply not stages.
 */
export function stackLineToStage(line: string): LoadingStage | null {
  // [windows-desktop] F10.6 — jiuwenswarm.mjs's wait-loop heartbeat (every 15s):
  // surfaces elapsed seconds on the loading page so a slow/hung start is
  // visible instead of a frozen "step 8/10, ~19s left".
  const wait = /JiuwenSwarm: still starting \((\d+)s elapsed, probe #(\d+)\)/.exec(line);
  if (wait) {
    return { stage: "jiuwenswarm", text: `智能体集群启动中… 已等 ${wait[1]}s（第 ${wait[2]} 次探测），组件较大属正常` };
  }
  // [windows-desktop] F10.6 — pre-loop phase heartbeats: the pre-check and
  // patch-verify steps run BEFORE the probe loop and can take minutes on a
  // cold machine with zero output (2026-10-17 field screenshot: step 8/10
  // frozen-looking with no probe count). Same silence class as above.
  if (/JiuwenSwarm: pre-checking instance status/.test(line)) {
    return { stage: "jiuwenswarm", text: "智能体集群：预检实例状态（冷机需数分钟，请稍候）…" };
  }
  if (/JiuwenSwarm: verifying compatibility patches/.test(line)) {
    return { stage: "jiuwenswarm", text: "智能体集群：校验兼容补丁（冷机需数分钟，请稍候）…" };
  }
  // F10.6l ①: init + applyConfig complete the pre-loop coverage — they were the
  // last silent steps before the probe loop (local acid test 2026-10-17:
  // applyConfig failed fast but the wizard still looked frozen for 654s).
  if (/JiuwenSwarm: initializing instance workspace/.test(line)) {
    return { stage: "jiuwenswarm", text: "智能体集群：正在初始化实例工作区（冷机需数分钟，请稍候）…" };
  }
  if (/JiuwenSwarm: applying instance config/.test(line)) {
    return { stage: "jiuwenswarm", text: "智能体集群：正在写入实例配置…" };
  }
  for (const [pattern, stage] of STACK_LINES) {
    if (pattern.test(line)) return { stage, text: STAGE_TEXTS[stage] };
  }
  if (/first run: unpacking/.test(line)) return { stage: "unpack", text: STAGE_TEXTS.unpack };
  if (/first run: precompiled bytecode/.test(line)) return { stage: "precompile", text: STAGE_TEXTS.precompile };
  return null;
}

/**
 * F10.6d2: first-run provisioning lines that should override the stage's
 * default text with live sub-progress (unpack percentage / per-venv
 * precompile results), so the two longest stages visibly move. Contract with
 * bootstrap.ts's log() calls. Null for everything else.
 */
export function provisioningLineToStage(line: string): LoadingStage | null {
  // Note: patterns are substring matches (no ^) — the shell's log() prefixes
  // lines with "[sd-shell] ", same contract as stackLineToStage.
  let m = /first run: unpack (\d+)% \((\d+)\/(\d+) files\)/.exec(line);
  if (m) return { stage: "unpack", text: `正在解包运行环境… ${m[1]}%（${m[2]}/${m[3]} 个文件）` };
  if (/first run: unpack complete/.test(line)) return { stage: "unpack", text: "运行环境解包完成" };
  m = /first run: precompiled bytecode for (.+?) \((\d+)s\)/.exec(line);
  if (m) return { stage: "precompile", text: `字节码预热完成：${m[1]}（${m[2]}s）` };
  // F10.6 ②: compileall exit 1 = partial success (Windows 260-char limit) —
  // surface it as progress, not as a scary "failed".
  m = /first run: precompile partially done for (.+?) \((\d+)s;/.exec(line);
  if (m) return { stage: "precompile", text: `字节码预热部分完成：${m[1]}（${m[2]}s，其余首启时自动编译）` };
  return null;
}
