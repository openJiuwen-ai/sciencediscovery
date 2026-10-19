// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { writeFile, realpath, access } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { buildSandboxLaunch, sandboxLaunchProfile, resolveHostRuntimeSupport } from "./executor.js";
import { ensureSeccompFilter } from "./seccomp.js";

/** Model-only transport. User commands use separate Runner executions and their
 * own network policy. Native Codex tools MUST remain disabled by the adapter. */
export async function prepareSpecialistLauncher(options: {
  binary: string; workspaceRoot: string; privateRoot: string; bwrapPath?: string;
}): Promise<string> {
  if (process.platform !== "linux") throw new Error("Specialist sandbox requires a Linux Runner");
  const binary = await realpath(options.binary);
  const requested = options.bwrapPath ?? "bwrap";
  let bwrapPath = requested;
  if (!isAbsolute(requested)) {
    const candidates = (process.env.PATH ?? "").split(":").map(directory => join(directory, requested));
    const found = await Promise.all(candidates.map(async path => { try { await access(path); return path; } catch { return undefined; } }));
    bwrapPath = found.find(Boolean) ?? requested;
  }
  bwrapPath = await realpath(bwrapPath);
  const launch = buildSandboxLaunch({
    ...await sandboxLaunchProfile(bwrapPath),
    chdir: options.workspaceRoot, language: "shell", pathEnv: "/usr/bin:/bin",
    environmentBinds: ["--ro-bind", binary, "/opt/sd-codex"],
    hostInterpreterMasks: [], hostRuntimeSupport: await resolveHostRuntimeSupport(options.privateRoot),
    workspaceBindArgs: ["--bind", options.workspaceRoot, options.workspaceRoot],
  });
  // Keep the SDK's explicitly allowlisted environment, including CODEX_API_KEY.
  // No credential is placed in a generated script or bwrap argv.
  launch.args.splice(launch.args.indexOf("--clearenv"));
  launch.args.push("--share-net", "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf", "--seccomp", "3");
  const filter = await ensureSeccompFilter(options.privateRoot, "network");
  const launcher = join(options.privateRoot, "launch.mjs");
  await writeFile(launcher, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { openSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
const args = ${JSON.stringify(launch.args)};
const cliArgs = process.argv.slice(2);
const index = cliArgs.indexOf('--output-schema');
if (index !== -1) {
  const schema = realpathSync(cliArgs[index + 1]);
  if (!schema.startsWith(join(tmpdir(), 'codex-output-schema-')) || !schema.endsWith('/schema.json')) process.exit(64);
  args.push('--ro-bind', dirname(schema), dirname(schema));
}
const child = spawn(${JSON.stringify(bwrapPath)}, [...args, '/opt/sd-codex', ...cliArgs], {
  env: { ...${JSON.stringify(launch.env)}, ...Object.fromEntries(['PATH', 'HOME', 'CODEX_HOME', 'CODEX_API_KEY'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) }, detached: true, stdio: ['inherit', 'inherit', 'inherit', openSync(${JSON.stringify(filter)}, 'r')]
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
child.on('error', () => process.exit(70));
child.on('exit', code => process.exit(code ?? 1));
`, { mode: 0o700 });
  return launcher;
}
