// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
//
// [windows-desktop] jiuwenswarm.sh 的跨平台 Node 等价物（F2.4）。
// 原 bash 脚本保持不动（Linux/macOS 用户不受影响）。平台分叉全部走
// scripts/lib/stack-platform.mjs（0.B2 分层约定）。

import { execFile, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { get } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  findHostPython, probeTcp, readTextIfExists,
  spawnDetached, venvEntry, venvPython,
} from "./lib/stack-platform.mjs";

const execFileAsync = promisify(execFile);

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
export const repositoryRoot = resolve(scriptDir, "..");

export function jwConfig(env = process.env) {
  const root = env.JIUWENSWARM_ROOT ?? join(repositoryRoot, ".sciencediscovery-data", "jiuwenswarm");
  let home = env.JIUWENSWARM_HOME;
  if (home && !/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(home)) home = join(repositoryRoot, home);
  const instance = env.JIUWENSWARM_INSTANCE ?? "sciencediscovery";
  return {
    tag: env.JIUWENSWARM_TAG ?? "workswarm0.2.6",
    gitUrl: env.JIUWENSWARM_GIT_URL ?? "https://gitcode.com/openJiuwen/jiuwenswarm.git",
    root,
    instance,
    // Independent of root: the Docker image bakes the install read-only.
    src: env.JIUWENSWARM_SRC ?? join(root, "src"),
    dataDir: home ? join(home, ".jiuwenswarm") : join(root, "data"),
    logFile: home ? join(home, `jiuwenswarm-${instance}.log`) : join(root, "jiuwenswarm.log"),
    home,
  };
}

const venvDir = cfg => join(cfg.src, ".venv");
const jwPython = cfg => venvEntry(venvDir(cfg), "python");

/**
 * [windows-desktop] F10.6k —— uv trampoline 规避（2026-10-17 外机全灭根因）。
 * venv 里的 console-script exe（uv trampoline）在 PE 资源（UV_PYTHON_PATH/
 * UV_SCRIPT_DATA/UV_TRAMPOLINE_KIND）里烧录了构建机的绝对路径
 * （E:\CodeFile\…\src\.venv\Scripts\python.exe）：在开发机上该路径存在，
 * 打包模式验证全程假阳性；在任何其他机器上 spawn 即报
 * "uv trampoline failed to spawn Python child process: entity not found"
 * （外机日志与本机改名 dev venv 的复现实验逐字一致）。
 * 绕法：从 venv 自己的 entry_points.txt（纯文本）解析 console-script 入口，
 * 用 venv 的 python.exe -c 直调 —— 零二进制手术、布局无关、jw 升级自动跟随。
 * 解析不到时回退旧 trampoline exe（路径存在时仍可用，开发模式不受影响）。
 */
const jwEntryCache = new Map();

export function resolveVenvEntry(venvAbs, name) {
  const key = `${venvAbs}::${name}`;
  if (jwEntryCache.has(key)) return jwEntryCache.get(key);
  let spec = null;
  try {
    const sitePackages = join(venvAbs, "Lib", "site-packages");
    for (const ent of readdirSync(sitePackages, { withFileTypes: true })) {
      if (!ent.isDirectory() || !ent.name.endsWith(".dist-info")) continue;
      let text;
      try {
        text = readFileSync(join(sitePackages, ent.name, "entry_points.txt"), "utf8");
      } catch {
        continue; // most dist-infos ship no entry_points.txt — keep scanning
      }
      const match = new RegExp(`^\\s*${name}\\s*=\\s*([\\w.]+):(\\w+)\\s*$`, "m").exec(text);
      if (match) {
        const code = `import sys; sys.argv[0] = ${JSON.stringify(name)}; `
          + `from ${match[1]} import ${match[2]} as _sd_entry; sys.exit(_sd_entry())`;
        spec = { exe: venvPython(venvAbs), args: ["-c", code] };
        break;
      }
    }
  } catch {
    /* fall through to the trampoline exe */
  }
  if (!spec) spec = { exe: venvEntry(venvAbs, name), args: [] };
  jwEntryCache.set(key, spec);
  return spec;
}

const jwEntry = (cfg, name) => resolveVenvEntry(venvDir(cfg), name);

/** "jw 已安装"语义：入口的 python.exe（entry_points 命中）或 trampoline
 *  exe（回退路径）实际存在 —— 等价于旧的 existsSync(jwBin(...)) 检查。 */
const jwInstalled = cfg => existsSync(resolveVenvEntry(venvDir(cfg), "jiuwenswarm-start").exe);

// [windows-desktop] F10.6 —— 启动链加固（owner 2026-10-16：新机器首启卡 8/10
// 600s+，是"卡住"不是"慢"）。三处根因对应三处修复：
//   1) 旧等待环上限是"90 次"而非"180 秒"——每次探测 spawn 冷 python 完整
//      import jw（冷机+杀软 30-60s/次），实际预算 45-90 分钟 → 改真·墙钟 deadline；
//   2) 探测靠 python `--status` → 改 TCP 直探 instance .env 的 GATEWAY_PORT，
//      python 只在终态确认时跑一次；
//   3) 子命令无超时、等待期零日志 → exec 一律加超时，环内定期打点，全链
//      阶段/耗时/退出码落 startup-diagnostics.log（新机器卡住时取回即可定位）。
const EXEC_TIMEOUT_MS = 180_000;   // 单条子命令（python）的墙钟上限
const PROBE_DEADLINE_MS = 240_000; // 等待 jw 就绪的总墙钟上限
const PROBE_INTERVAL_MS = 2_000;
const PROBE_PROGRESS_MS = 15_000;  // 打点间隔（stderr → shell.log → loading 页文案）

/** 诊断日志路径：随 jw root 落盘（打包模式 = %LOCALAPPDATA%\ScienceDiscovery\jiuwenswarm\）。 */
export function startupDiagPath(cfg) {
  return join(cfg.root, "startup-diagnostics.log");
}

/** 追加一行时间戳诊断。fire-and-forget：诊断写失败绝不影响启动链本身。 */
export function diag(cfg, message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  return appendFile(startupDiagPath(cfg), line, "utf8").catch(() => {});
}

/** 错误摘要：message + 命令退出信息 + stderr 尾部（截断），供诊断文件定位"卡在哪条命令"。 */
export function stderrTail(text, maxChars = 600) {
  if (!text) return "";
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length <= maxChars ? clean : `…${clean.slice(-maxChars)}`;
}

function errSummary(error) {
  const e = error ?? {};
  const parts = [String(e.message ?? e)];
  if (e.killed || e.signal) parts.push(`killed=${e.killed ?? false} signal=${e.signal ?? ""}`);
  if (e.code) parts.push(`code=${e.code}`);
  const tail = stderrTail(e.stderr ?? "");
  if (tail) parts.push(`stderr: ${tail}`);
  return parts.join(" | ");
}

function run(command, args, { cwd, env, timeoutMs = EXEC_TIMEOUT_MS } = {}) {
  return execFileAsync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    // F10.6t: every jw setup/CLI step routes through here; from the
    // console-less packaged shell each execFile of a console-subsystem child
    // (python.exe) would otherwise allocate its own BLANK console window
    // (stdio is piped away, so nothing prints — field 2026-10-19: empty cmd
    // flashes during first-run init). Hide them all in one place.
    windowsHide: true,
    timeout: timeoutMs,
  });
}

/** run() 的诊断版：起止/耗时/失败摘要（含 stderr 尾部）都落诊断文件。 */
async function runLogged(cfg, label, command, args, opts = {}) {
  const started = Date.now();
  await diag(cfg, `▶ ${label}: ${command} ${args.map(a => `"${a}"`).join(" ")}`);
  try {
    const result = await run(command, args, opts);
    await diag(cfg, `✔ ${label}: ok in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return result;
  } catch (error) {
    await diag(cfg, `✖ ${label}: failed in ${((Date.now() - started) / 1000).toFixed(1)}s — ${errSummary(error)}`);
    throw error;
  }
}

function instanceWorkspace(cfg) {
  return join(cfg.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "", ".jiuwenswarm-instances", cfg.instance);
}

/**
 * [windows-desktop] F10.6l ③ —— 实例 workspace 的 config.yaml 路径。init 是否
 * 需要跑应判它（而非 workspace 目录存在）：半成品 workspace（目录在、
 * config\config.yaml 缺——进程被杀中途/历史残留，2026-10-17 本机实测）
 * 会让 applyConfig 直接抛 "config.yaml not found; run setup first"。
 */
export function instanceConfigPath(cfg) {
  return join(instanceWorkspace(cfg), "config", "config.yaml");
}

/** `jiuwenswarm-start --status` → { raw, running, ports: {gateway, web, agent_server} } */
export async function instanceStatus(cfg) {
  const entry = jwEntry(cfg, "jiuwenswarm-start");
  const { stdout } = await runLogged(cfg, "status", entry.exe, [...entry.args, "--status", cfg.instance], {
    env: { JIUWENSWARM_DATA_DIR: cfg.dataDir, ...(cfg.home ? { JIUWENSWARM_HOME: cfg.home } : {}) },
  });
  const ports = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(gateway|web|agent_server):\s*(\S+)\s*$/.exec(line);
    if (match) ports[match[1]] = match[2];
  }
  return { raw: stdout, running: /^\s*Status:\s+running\s*$/m.test(stdout), ports };
}

/** is_up: all three instance ports answer. Fast path probes the .env ports
 *  with bare TCP (no python spawn — a cold `jiuwenswarm-start --status` is a
 *  full jw import, 30-60s on cold machines); the python status check only
 *  runs when the ports don't all answer (to tell "still starting" from
 *  "another process squatted the port"). */
export async function isUp(cfg) {
  try {
    const ports = await readInstancePorts(cfg);
    if (ports?.gateway && ports.web && ports.agentServer) {
      const answers = await Promise.all([
        probeTcp("127.0.0.1", ports.gateway),
        probeTcp("127.0.0.1", ports.web),
        probeTcp("127.0.0.1", ports.agentServer),
      ]);
      if (answers.every(Boolean)) return true;
    }
    const status = await instanceStatus(cfg);
    if (!status.running || !status.ports.gateway) return false;
    const expected = [Number(status.ports.gateway), Number(status.ports.web), Number(status.ports.agent_server)].filter(Boolean);
    const results = await Promise.all(expected.map(p => probeTcp("127.0.0.1", p)));
    return results.every(Boolean);
  } catch {
    return false;
  }
}

/**
 * [windows-desktop] F10.6 —— Parse the bootstrap .env that jiuwenswarm-init
 * writes into the instance workspace (AGENT_SERVER_PORT / WEB_PORT /
 * GATEWAY_PORT). Pure — the probe loop reads these to TCP-probe the gateway
 * without spawning a cold python per attempt. Null when nothing parses.
 */
export function parseInstanceEnvPorts(text) {
  if (!text) return null;
  const get = name => {
    const match = new RegExp(`^\\s*${name}=(\\d+)\\s*$`, "m").exec(text);
    return match ? Number(match[1]) : undefined;
  };
  const ports = {
    gateway: get("GATEWAY_PORT"),
    web: get("WEB_PORT"),
    agentServer: get("AGENT_SERVER_PORT"),
  };
  return ports.gateway || ports.web || ports.agentServer ? ports : null;
}

/** This instance's ports from its bootstrap .env (no python spawn). */
export async function readInstancePorts(cfg) {
  const text = await readTextIfExists(join(instanceWorkspace(cfg), ".env"));
  return parseInstanceEnvPorts(text);
}

async function applyCompatibilityPatches(cfg) {
  const python = findHostPython();
  if (!python) throw new Error("python3/python is required to apply the compatibility patches.");
  await run(python, [join(scriptDir, "swarm-patches.py"), "apply", cfg.src, cfg.tag]);
}

const PATCHES_VERIFIED_MARKER = ".sd-patches-verified";

function getVerifiedTag(cfg) {
  try {
    const marker = join(cfg.root, PATCHES_VERIFIED_MARKER);
    const text = readFileSync(marker, "utf8").trim();
    // "tag:srcPath" — if either changes, re-verify.
    return text.startsWith(`${cfg.tag}:${cfg.src}`) ? cfg.tag : null;
  } catch {
    return null;
  }
}

function recordVerified(cfg) {
  try {
    const marker = join(cfg.root, PATCHES_VERIFIED_MARKER);
    writeFileSync(marker, `${cfg.tag}:${cfg.src}`, "utf8");
  } catch { /* marker is best-effort */ }
}

async function verifyCompatibilityPatches(cfg) {
  if (getVerifiedTag(cfg) === cfg.tag) {
    process.stderr.write("JiuwenSwarm: compatibility patches already verified; skipping.\n");
    return;
  }
  const { stdout } = await runLogged(cfg, "verify-locate", jwPython(cfg), [
    "-c", "import importlib.util,pathlib; print(pathlib.Path(importlib.util.find_spec('jiuwenswarm').origin).parent.parent)",
  ]);
  await runLogged(cfg, "verify", jwPython(cfg), [join(scriptDir, "swarm-patches.py"), "verify", stdout.trim().split(/\r?\n/).pop(), cfg.tag]);
  recordVerified(cfg);
}

/** The three settings the adapter depends on, applied idempotently.
 *  Direct JS port of the inline Python in jiuwenswarm.sh apply_config(). */
export async function applyConfig(cfg, { contextWindowTokens = process.env.JIUWENSWARM_CONTEXT_WINDOW_TOKENS ?? "" } = {}) {
  const configPath = join(instanceWorkspace(cfg), "config", "config.yaml");
  let text = await readTextIfExists(configPath);
  if (text === undefined) throw new Error(`${configPath} not found; run setup first.`);

  // MCP tools must be direct tools: the adapter reaches the model through its
  // own proxy under the tool names ScienceDiscovery defined.
  if (/^progressive_tool_enabled:.*$/m.test(text)) {
    text = text.replace(/^progressive_tool_enabled:.*$/m, "progressive_tool_enabled: false");
  } else {
    text = `progressive_tool_enabled: false\n${text}`;
  }

  const marker = "  # set by scripts/jiuwenswarm.sh";
  const windowValue = contextWindowTokens.trim();
  text = text.replace(new RegExp(`^    context_window_tokens:.*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n`, "m"), "");
  if (windowValue) {
    if (!/^\d+$/.test(windowValue) || Number(windowValue) <= 0) {
      throw new Error("JIUWENSWARM_CONTEXT_WINDOW_TOKENS must be a positive integer");
    }
    const engine = /^(  context_engine_config:\r?\n)/m;
    if (!engine.test(text)) throw new Error(`context_engine_config not found in ${configPath}`);
    text = text.replace(engine, `$1    context_window_tokens: ${windowValue}${marker}\n`);
  }
  await writeFile(configPath, text, "utf8");
  process.stderr.write(`config: progressive_tool_enabled: false${windowValue ? `, context_window_tokens: ${windowValue}` : ""}\n`);

  // Free search switches: registered only at start-up; default on until the
  // API applies the System Settings values with config.set.
  const envPath = join(instanceWorkspace(cfg), "config", ".env");
  const envText = (await readTextIfExists(envPath)) ?? "";
  const missing = ["FREE_SEARCH_DDG_ENABLED", "FREE_SEARCH_BING_ENABLED"]
    .filter(name => !new RegExp(`^${name}=`, "m").test(envText));
  if (missing.length) {
    const prefix = envText === "" || envText.endsWith("\n") ? "" : "\n";
    await appendFile(envPath, prefix + missing.map(name => `${name}="true"\n`).join(""), "utf8");
  }
}

export async function cmdSetup(cfg = jwConfig()) {
  if (jwInstalled(cfg) && !existsSync(join(cfg.src, ".git"))) {
    // Pre-baked (Docker image style): nothing to clone, only verify patches.
    process.stderr.write(`Using the pre-installed JiuwenSwarm at ${cfg.src}.\n`);
    await verifyCompatibilityPatches(cfg);
  } else {
    const git = spawnSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
    if (git.status !== 0) throw new Error("git is required: install git");
    const uv = spawnSync("uv", ["--version"], { stdio: "ignore", windowsHide: true });
    if (uv.status !== 0) throw new Error("uv is required: https://docs.astral.sh/uv/");

    await mkdir(cfg.root, { recursive: true });
    if (!existsSync(join(cfg.src, ".git"))) {
      process.stderr.write(`Cloning JiuwenSwarm ${cfg.tag}...\n`);
      await run("git", ["clone", "--quiet", "--depth", "1", "--branch", cfg.tag, cfg.gitUrl, cfg.src]);
    } else {
      const { stdout } = await run("git", ["-C", cfg.src, "describe", "--tags", "--exact-match"]).catch(() => ({ stdout: "" }));
      const have = stdout.trim();
      if (have !== cfg.tag) {
        throw new Error(`${cfg.src} is at '${have || "an untagged commit"}', not ${cfg.tag}. Remove it or set JIUWENSWARM_ROOT.`);
      }
    }
    await applyCompatibilityPatches(cfg);
    process.stderr.write("Installing JiuwenSwarm (Python 3.12, its own virtualenv)...\n");
    await run("uv", ["sync", "--python", "3.12"], {
      cwd: cfg.src,
      env: {
        UV_HTTP_TIMEOUT: process.env.UV_HTTP_TIMEOUT ?? "300",
        ...(process.env.SCIENCE_AGENT_PYPI_INDEX ? { UV_DEFAULT_INDEX: process.env.SCIENCE_AGENT_PYPI_INDEX } : {}),
      },
    });
  }
  await mkdir(cfg.dataDir, { recursive: true });
  if (!existsSync(instanceWorkspace(cfg))) {
    process.stderr.write(`Creating instance ${cfg.instance}...\n`);
    const entry = jwEntry(cfg, "jiuwenswarm-init");
    await run(entry.exe, [...entry.args, "--name", cfg.instance], {
      env: { JIUWENSWARM_DATA_DIR: cfg.dataDir, ...(cfg.home ? { JIUWENSWARM_HOME: cfg.home } : {}) },
    });
  }
  await applyConfig(cfg);
  process.stderr.write("Done. Start it with: node scripts/jiuwenswarm.mjs start\n");
}

export async function cmdStart(cfg = jwConfig()) {
  const startedAt = Date.now();
  await diag(cfg, `──── start begin: instance=${cfg.instance} pid=${process.pid}`);
  await diag(cfg, `config: root=${cfg.root} src=${cfg.src} dataDir=${cfg.dataDir} log=${cfg.logFile} home=${cfg.home ?? "(unset)"}`);
  try {
    if (!jwInstalled(cfg)) {
      throw new Error("Not installed; run: node scripts/jiuwenswarm.mjs setup");
    }
    // [windows-desktop] F10 —— packaged 首启（或源码模式忘记 init）没有 instance
    // workspace：applyConfig 需要它的 config.yaml。jiuwenswarm-init 是离线脚手架
    // （从包内模板生成 config），与 cmdSetup 末段同一条命令，幂等。
    // [windows-desktop] F10.6l ③ —— 判定从「workspace 目录存在」收紧为
    // 「config\config.yaml 存在」（见 instanceConfigPath）。
    if (!existsSync(instanceConfigPath(cfg))) {
      // [windows-desktop] F10.6l ① —— init 是环前最长静默步（冷机一次完整
      // python import），与 pre-check/verify 同类：进入即打一行，映射到
      // loading/向导页，不再零输出形似冻结。
      process.stderr.write(`JiuwenSwarm: initializing instance workspace "${cfg.instance}" (cold machine: this can take a few minutes)...\n`);
      const initStarted = Date.now();
      await mkdir(cfg.dataDir, { recursive: true });
      const entry = jwEntry(cfg, "jiuwenswarm-init");
      await runLogged(cfg, "init", entry.exe, [...entry.args, "--name", cfg.instance], {
        env: { JIUWENSWARM_DATA_DIR: cfg.dataDir, ...(cfg.home ? { JIUWENSWARM_HOME: cfg.home } : {}) },
      });
      await diag(cfg, `[perf] jiuwenswarm-init elapsed=${Date.now() - initStarted}ms`);
    }
    const configStarted = Date.now();
    // [windows-desktop] F10.6l ① —— applyConfig 同为环前静默步，进入即打一行。
    process.stderr.write("JiuwenSwarm: applying instance config...\n");
    await applyConfig(cfg);
    await diag(cfg, `applyConfig: ok in ${((Date.now() - configStarted) / 1000).toFixed(1)}s`);

    // [windows-desktop] F10.6 —— 起前快查：TCP 直探 .env 里的 GATEWAY_PORT；
    // 不通直接视为未启动（省一次冷 python status —— 冷机一次就是一个完整
    // jw import，30-60s+）。TCP 通了才用 python status 确认真在跑（防端口
    // 恰好被别的进程占用）。
    const ports = await readInstancePorts(cfg);
    await diag(cfg, `instance ports (.env): ${ports ? `gateway=${ports.gateway} web=${ports.web} agent=${ports.agentServer}` : "unavailable (fallback: python status probes)"}`);
    // [windows-desktop] F10.6 —— 前置阶段心跳：预检/补丁校验在冷机上要数
    // 分钟（每个 exec 180s 超时但串行），此前零输出，8/10 表现为冻结
    // （2026-10-17 外机实测截图证实）。探测环的「已等 Ns」管不到这里。
    process.stderr.write("JiuwenSwarm: pre-checking instance status (cold machine: this can take a few minutes)...\n");
    let alreadyUp;
    if (ports?.gateway) {
      alreadyUp = (await probeTcp("127.0.0.1", ports.gateway)) && (await isUp(cfg));
    } else {
      alreadyUp = await isUp(cfg);
    }
    if (alreadyUp) {
      process.stderr.write(`JiuwenSwarm instance ${cfg.instance} is already up.\n`);
      await diag(cfg, "pre-check: already up");
      return;
    }
    process.stderr.write("JiuwenSwarm: verifying compatibility patches (cold machine: this can take a few minutes)...\n");
    const verifyStarted = Date.now();
    await verifyCompatibilityPatches(cfg);
    await diag(cfg, `[perf] verifyCompatibilityPatches elapsed=${Date.now() - verifyStarted}ms`);
    // Detached completely (the nohup/disown equivalent): a background job that
    // keeps the caller's stdout open makes piping scripts wait forever.
    // [windows-desktop] F10.6 —— spawnDetached 以追加模式打开日志文件；当
    // instance 工作区还在但 jw root（打包模式 = dataDir\jiuwenswarm）被清空
    // 时该目录可能不存在，openSync 直接抛错 → 先确保目录存在。
    await mkdir(dirname(cfg.logFile), { recursive: true });
    const bootstrapPath = join(repositoryRoot, "services", "adapter", "src", "sciencediscovery_adapter");
    const startEntry = jwEntry(cfg, "jiuwenswarm-start");
    const spawnStarted = Date.now();
    const child = spawnDetached(startEntry.exe, [...startEntry.args, "--name", cfg.instance, "app"], {
      cwd: cfg.root,
      logFile: cfg.logFile,
      env: {
        SCIENCE_AGENT_JIUWENSWARM_BOOTSTRAP: "1",
        PYTHONPATH: [bootstrapPath, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
        JIUWENSWARM_DATA_DIR: cfg.dataDir,
        ...(cfg.home ? { JIUWENSWARM_HOME: cfg.home } : {}),
      },
    });
    await diag(cfg, `spawn: detached pid=${child.pid ?? "?"} log=${cfg.logFile} elapsed=${Date.now() - spawnStarted}ms`);

    // [windows-desktop] F10.6 —— 等待环：真·墙钟 deadline（240s）+ TCP 直探
    // （毫秒级，替代旧的"每 2s 一个冷 python status"）+ 每 15s 打点（stderr →
    // shell.log → loading 页显示"已等 Ns"，卡住不再表现为冻结）。旧行为的
    // "90 次 × 冷 python" 在杀软机器上实为 45-90 分钟假死，见文件头注释。
    const loopStartedAt = Date.now();
    const deadline = loopStartedAt + PROBE_DEADLINE_MS;
    let attempt = 0;
    let lastProgressAt = 0;
    for (;;) {
      if (Date.now() >= deadline) break;
      attempt += 1;
      const listening = ports?.gateway
        ? await probeTcp("127.0.0.1", ports.gateway, 2000)
        : await isUp(cfg); // 无 .env 端口的兜底：python status（单次有超时，总时长被 deadline 罩住）
      if (listening) {
        // Gateway binds first; web + agent_server follow seconds later. Poll
        // those two tightly (no fixed 6s sleep, no cold-python status — the
        // old confirmation was a full jw import that cost 30-60s on every
        // start), then confirm the web port actually speaks HTTP.
        // ports === null (no .env): listening came from the isUp() fallback,
        // which already confirmed all three ports — nothing left to wait for.
        const settleNeeded = Boolean(ports?.web && ports?.agentServer);
        const settleDeadline = Date.now() + 30_000;
        let settled = !settleNeeded;
        while (!settled && Date.now() < settleDeadline) {
          const restAnswer = await Promise.all([
            probeTcp("127.0.0.1", ports.web, 1000),
            probeTcp("127.0.0.1", ports.agentServer, 1000),
          ]);
          if (restAnswer.every(Boolean)) { settled = true; break; }
          await delay(500);
        }
        if (!settled) {
          await diag(cfg, `probe #${attempt}: gateway answered but web/agent_server did not settle in 30s; continuing`);
          await delay(PROBE_INTERVAL_MS);
          continue;
        }
        let httpOk = true;
        if (ports?.web) {
          httpOk = await new Promise(resolveHttp => {
            const req = get(`http://127.0.0.1:${ports.web}/`, { timeout: 3000 }, res => { res.resume(); resolveHttp(true); });
            req.on("error", () => resolveHttp(false));
            req.on("timeout", () => { req.destroy(); resolveHttp(false); });
          });
        }
        if (httpOk) {
          process.stderr.write(`JiuwenSwarm instance ${cfg.instance} is up (gateway ${ports?.gateway ?? "?"}, web ${ports?.web ?? "?"}, agent ${ports?.agentServer ?? "?"}).\n`);
          await diag(cfg, `up: attempt #${attempt} gateway=${ports?.gateway ?? "?"} web=${ports?.web ?? "?"} agent=${ports?.agentServer ?? "?"} (tcp+http, no python status)`);
          return;
        }
        await diag(cfg, `probe #${attempt}: ports answered but web HTTP check failed; continuing`);
      } else {
        const elapsedSec = Math.round((Date.now() - loopStartedAt) / 1000);
        if (Date.now() - lastProgressAt >= PROBE_PROGRESS_MS) {
          lastProgressAt = Date.now();
          process.stderr.write(`JiuwenSwarm: still starting (${elapsedSec}s elapsed, probe #${attempt})...\n`);
          await diag(cfg, `probe #${attempt}: gateway ${ports?.gateway ?? "?"} not listening after ${elapsedSec}s`);
        }
      }
      await delay(PROBE_INTERVAL_MS);
    }
    throw new Error(
      `JiuwenSwarm did not come up within ${PROBE_DEADLINE_MS / 1000}s (probes: ${attempt}); ` +
      `diagnostics: ${startupDiagPath(cfg)}; instance log: ${cfg.logFile}`,
    );
  } finally {
    await diag(cfg, `──── start end: total=${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  }
}

export async function cmdStop(cfg = jwConfig()) {
  if (!jwInstalled(cfg)) return;
  const entry = jwEntry(cfg, "jiuwenswarm-start");
  await run(entry.exe, [...entry.args, "--stop", cfg.instance], {
    env: { JIUWENSWARM_DATA_DIR: cfg.dataDir, ...(cfg.home ? { JIUWENSWARM_HOME: cfg.home } : {}) },
  }).catch(() => {});
}

/** env: the exports the adapter needs (start-stack consumes them directly). */
export async function jwEnv(cfg = jwConfig()) {
  if (!jwInstalled(cfg)) {
    throw new Error("Not installed; run: node scripts/jiuwenswarm.mjs setup");
  }
  const status = await instanceStatus(cfg);
  if (!status.ports.gateway || !status.ports.web) {
    throw new Error("Could not read the instance ports.");
  }
  // Chats use the gateway's /tui route; management calls (mcp.*, models.*) /ws.
  return {
    JIUWENSWARM_GATEWAY_URL: `ws://127.0.0.1:${status.ports.gateway}/tui`,
    JIUWENSWARM_MGMT_URL: `ws://127.0.0.1:${status.ports.web}/ws`,
  };
}

async function main() {
  const cfg = jwConfig();
  switch (process.argv[2]) {
    case "setup": await cmdSetup(cfg); break;
    case "start": await cmdStart(cfg); break;
    case "stop": await cmdStop(cfg); break;
    case "status": {
      if (!jwInstalled(cfg)) { console.log("not installed"); process.exitCode = 1; break; }
      const status = await instanceStatus(cfg);
      process.stdout.write(status.raw);
      if (await isUp(cfg)) console.log("gateway: reachable");
      else { console.log("gateway: not reachable"); process.exitCode = 1; }
      break;
    }
    case "env": {
      const env = await jwEnv(cfg);
      console.log(`export JIUWENSWARM_GATEWAY_URL=${env.JIUWENSWARM_GATEWAY_URL}`);
      console.log(`export JIUWENSWARM_MGMT_URL=${env.JIUWENSWARM_MGMT_URL}`);
      break;
    }
    default:
      process.stderr.write([
        "Usage: node scripts/jiuwenswarm.mjs <setup|start|stop|status|env>",
        "",
        "Cross-platform (Windows/macOS/Linux) equivalent of scripts/jiuwenswarm.sh.",
        "Env: JIUWENSWARM_TAG / JIUWENSWARM_GIT_URL / JIUWENSWARM_ROOT / JIUWENSWARM_SRC /",
        "     JIUWENSWARM_INSTANCE / JIUWENSWARM_HOME / SCIENCE_AGENT_PYPI_INDEX / UV_HTTP_TIMEOUT",
        "",
      ].join("\n"));
      if (process.argv[2] && !["-h", "--help", "help"].includes(process.argv[2])) process.exitCode = 2;
  }
}

const invokedAsCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
