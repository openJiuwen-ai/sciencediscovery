// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/** Bridge for the explicitly provisioned source/container stack; no default port or public token. */
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { privateEvolveToken } from "./evolve-install.js";
import { defaultBootstrapIo, withBootstrapLock } from "./bootstrap.js";
import { EvolveRuntime, createEvolveControl, evolveChildEnvironment, evolveStartupTimeoutMs, type EvolveControl } from "./evolve-runtime.js";

export async function startSourceEvolve(python: string, dataDir: string, stateFile: string, signal?: AbortSignal): Promise<EvolveControl> {
  const parent = join(dataDir, "evolve");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const log = (message: string) => process.stderr.write(`${message}\n`);
  const token = await withBootstrapLock(parent, defaultBootstrapIo(log), () => privateEvolveToken(dataDir), signal);
  // The source stack has explicitly provisioned this interpreter with uv sync.
  // Reuse the same socket/process supervision as the slim-binary installer.
  const context = { dataDir, env: evolveChildEnvironment(process.env, true) };
  const runtime = new EvolveRuntime(context, { install: async () => ({ python, root: dataDir, token }), spawn, fetch, startupTimeoutMs: evolveStartupTimeoutMs(process.env), allowRuntimeProvisioning: true });
  const control = await createEvolveControl(runtime, signal);
  try {
    if (runtime.status().state !== "ready") throw new Error("Source Evolve failed readiness checks");
    const staging = `${stateFile}.${process.pid}.tmp`;
    try {
      const file = await open(staging, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(control.env)); await file.sync(); }
      finally { await file.close(); }
      await rename(staging, stateFile);
    } finally { await rm(staging, { force: true }); }
    signal?.throwIfAborted();
    return { ...control, close: async () => { await control.close(); await rm(stateFile, { force: true }); } };
  } catch (error) { await control.close(); await rm(stateFile, { force: true }); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [python, dataDir, stateFile] = process.argv.slice(2);
  if (!python || !dataDir || !stateFile) throw new Error("Expected interpreter, data directory and private state file");
  const controller = new AbortController();
  let control: EvolveControl | undefined;
  const stop = () => { controller.abort(); void control?.close(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  startSourceEvolve(python, dataDir, stateFile, controller.signal).then(value => { control = value; if (controller.signal.aborted) void value.close(); }).catch(() => {
    if (!controller.signal.aborted) process.stderr.write("Evolve could not start. Check the provisioned source runtime.\n");
    process.exitCode = controller.signal.aborted ? 0 : 1;
  });
}
