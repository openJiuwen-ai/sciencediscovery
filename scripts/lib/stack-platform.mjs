// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
//
// [windows-desktop] scripts/ 的 platform 适配层（0.B2《Windows 适配分层约定》§2 在
// 脚本层的落点）：所有 Windows/posix 分叉收敛到本文件，start-stack.mjs 与
// jiuwenswarm.mjs 只 import 这里的出口，不写内联 process.platform 分支。

import { spawn, spawnSync } from "node:child_process";
import { createServer, Socket } from "node:net";
import { closeSync, existsSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";

/** Resolve a value that may be relative to the repository root. Absolute forms:
 *  posix `/x`, Windows `C:\x` / `C:/x`, UNC `\\host\share`. */
export function absoluteFromRepository(repositoryRoot, value) {
  if (/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(value)) return value;
  return join(repositoryRoot, value);
}

/** The Python interpreter inside a uv/virtualenv environment directory.
 *  posix: <env>/bin/python; Windows: <env>/Scripts/python.exe. */
export function venvPython(envDir) {
  return isWindows
    ? join(envDir, "Scripts", "python.exe")
    : join(envDir, "bin", "python");
}

/** The directory holding a venv's console entry points
 *  (jiuwenswarm-start etc.): posix `bin/`, Windows `Scripts/`. */
export function venvBinDir(envDir) {
  return join(envDir, isWindows ? "Scripts" : "bin");
}

/** Console entry point inside a venv, with the Windows .exe suffix. */
export function venvEntry(envDir, name) {
  return join(venvBinDir(envDir), isWindows ? `${name}.exe` : name);
}

/** Find a command on PATH (honours PATHEXT on Windows). Returns the absolute
 *  path or undefined. Pure filesystem scan — no shell involved. */
export function findOnPath(command, env = process.env) {
  const pathExt = isWindows
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const names = isWindows && !pathExt.some(ext => command.toUpperCase().endsWith(ext))
    ? pathExt.map(ext => command + ext.toLowerCase())
    : [command];
  // Windows: a reconstructed env (e.g. under `node --test`) may carry the
  // variable as "Path" — the lookup itself stays case-sensitive in JS.
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Host Python discovery chain: explicit env → py launcher → python3 → python.
 *  Windows machines commonly have `python` but not `python3` (炸点③-6). */
export function findHostPython(env = process.env) {
  if (env.SCIENCE_AGENT_PYTHON_PATH && existsSync(env.SCIENCE_AGENT_PYTHON_PATH)) {
    return env.SCIENCE_AGENT_PYTHON_PATH;
  }
  if (isWindows) {
    const pyLauncher = findOnPath("py", env);
    if (pyLauncher) {
      const probe = spawnSync(pyLauncher, ["-3", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
      if (probe.status === 0) return probe.stdout.trim().split(/\r?\n/).pop();
    }
  }
  for (const name of isWindows ? ["python3", "python"] : ["python3"]) {
    const found = findOnPath(name, env);
    if (found) return found;
  }
  return undefined;
}

/** Minimal .env loader for the subset start-stack.sh gets via `set -a; source`.
 *  KEY=VALUE lines, optional `export ` prefix, optional quotes, # comments.
 *  Existing environment variables win (same as sourcing order in the shell).
 *  No command substitution — that is a bash feature, not a config format. */
export async function loadDotEnv(file, env = process.env) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  let loaded = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[match[1]] === undefined) {
      env[match[1]] = value;
      loaded += 1;
    }
  }
  return loaded;
}

/** TCP connect probe — the cross-platform answer to bash's /dev/tcp
 *  (used for "is the gateway already listening" reachability checks). */
export function probeTcp(host, port, timeoutMs = 2000) {
  return new Promise(resolveProbe => {
    const socket = new Socket();
    const done = ok => { socket.destroy(); resolveProbe(ok); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
    socket.connect(port, host);
  });
}

/** Bind test — the truthful "can we listen here" check. Catches Windows
 *  reserved port ranges (EACCES, 炸点③-4), not just occupied ports. */
export async function portAvailability(host, port) {
  return new Promise(resolveProbe => {
    const server = createServer();
    server.once("error", error => resolveProbe({ ok: false, code: error.code }));
    server.once("listening", () => server.close(() => resolveProbe({ ok: true })));
    server.listen({ host, port });
  });
}

/** Identify the process LISTENING on a local TCP port: "python.exe (PID 1234)".
 *
 * F10.6s: the port-conflict fail-fast used to tell the user to run
 * netstat themselves; on a packaged install (console-less parent) that is a
 * dead end for a tester. Resolve the occupant right here instead — best
 * effort, null when the tools are unavailable or the port has no listener. */
export function portOccupant(port) {
  if (!isWindows) return null;
  try {
    const netstat = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    if (netstat.status !== 0 || !netstat.stdout) return null;
    // TCP    127.0.0.1:17674    0.0.0.0:0    LISTENING    12345
    const line = netstat.stdout.split(/\r?\n/).find(l => {
      const cols = l.trim().split(/\s+/);
      return cols[0] === "TCP" && cols[3] === "LISTENING" && cols[1]?.endsWith(`:${port}`);
    });
    const pid = line?.trim().split(/\s+/).pop();
    if (!pid || !/^\d+$/.test(pid) || Number(pid) === 0) return null;
    const tasklist = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    const out = (tasklist.status === 0 ? tasklist.stdout : "") ?? "";
    const name = out.startsWith("INFO:") ? "" : (out.split(",")[0] ?? "").replace(/"/g, "").trim();
    return name ? `${name} (PID ${pid})` : `PID ${pid}`;
  } catch {
    return null;
  }
}

/** Poll a health endpoint (replaces curl in the bash script). */
export async function waitHealthy(name, url, { timeoutSeconds = 10, intervalMs = 200 } = {}) {
  const attempts = Math.max(1, Math.round((timeoutSeconds * 1000) / intervalMs));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(intervalMs, 1000)) });
      if (response.ok) return true;
    } catch { /* not up yet */ }
    await delay(intervalMs);
  }
  process.stderr.write(`${name} did not become healthy at ${url} after ${Math.round(attempts * intervalMs / 1000)}s.\n`);
  return false;
}

/** Resolve a service command against the environment its child will get:
 *  callers pass *overrides* (e.g. { UV_PROJECT_ENVIRONMENT }), and looking up
 *  the command in the overrides alone finds no PATH at all. */
export function serviceCommand(command, env) {
  return command.includes(sep) || command.includes("/")
    ? command
    : findOnPath(command, { ...process.env, ...env });
}

/** Spawn a long-lived stack process. argv[0] is an absolute interpreter or a
 *  bare command resolved through PATH (.cmd suffix handled by findOnPath). */
export function spawnService(command, args, { env, cwd, stdio = "inherit" } = {}) {
  const resolved = serviceCommand(command, env);
  if (!resolved) throw new Error(`command not found on PATH: ${command}`);
  return spawn(resolved, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio,
    // Windows: no POSIX signals, children die via killTree (taskkill /T).
    // posix: keep default (same process group semantics as the bash script).
    windowsHide: true,
  });
}

/** Spawn fully detached with output to a log file — the Windows-capable
 * equivalent of `nohup … >log 2>&1 </dev/null & disown` (jiuwenswarm start).
 *
 * F10.6u: on Windows do NOT pass detached:true. With a console-less parent
 * (the Electron shell) the DETACHED_PROCESS + CREATE_NO_WINDOW flag combo
 * let Win11's default-terminal host open a VISIBLE console for the jw entry
 * python in the packaged first-run (field 2026-10-19; reproduced once —
 * window hosting .venv\Scripts\python.exe appeared 1.2s after spawn; four
 * byte-identical replications stayed clean, so the trigger is
 * non-deterministic). The five spawnService'd services (windowsHide, never
 * detached) have never shown a window anywhere — make this spawn
 * flag-identical to them. detached is unnecessary on Windows anyway:
 * children outlive their parent (no job object) and stop paths use
 * taskkill /T. POSIX keeps detached (setsid semantics). */
export function spawnDetached(command, args, { env, cwd, logFile }) {
  const out = openSync(logFile, "a");
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: !isWindows,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  // The child owns its dup'd handles from here on; the parent closing its own
  // descriptor does not disturb the child's logging and stops the parent from
  // leaking one fd per detached start.
  closeSync(out);
  child.unref();
  return child;
}

/** Stop a process tree. posix: SIGTERM. Windows: taskkill /T /F
 *  (process.kill on Windows is always a hard kill and does not reach children). */
export function killTree(child) {
  if (!child || child.pid === undefined) return;
  try {
    if (isWindows) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch { /* already gone */ }
}

/** Read a small text file as UTF-8, tolerating a missing file. */
export async function readTextIfExists(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
