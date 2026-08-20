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

import { spawn } from "node:child_process";
import { glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import type {
  RemoteHostCapabilities,
  RemoteJob,
  RemoteJobOutputRecord,
} from "@sciencediscovery/schema";

const MAX_SSH_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PULLED_OUTPUT_BYTES = 1024 * 1024;

export interface RemoteCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface RemoteTransport {
  run(alias: string, script: string, timeoutMs: number): Promise<RemoteCommandResult>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validateAlias(alias: string): string {
  const normalized = alias.trim();
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(normalized)) {
    throw new Error("SSH host alias must contain only letters, numbers, dots, underscores, and hyphens");
  }
  return normalized;
}

function validateRemotePath(path: string, label: string): string {
  const normalized = path.trim();
  if (!normalized.startsWith("/") || normalized.includes("\0") || normalized.includes("\n") || normalized.length > 2_000) {
    throw new Error(`${label} must be an absolute remote POSIX path of at most 2000 characters`);
  }
  return normalized;
}

async function collectConfigAliases(configPath: string, visited = new Set<string>()): Promise<Set<string>> {
  const canonical = resolve(configPath);
  if (visited.has(canonical)) return new Set();
  visited.add(canonical);
  const content = await readFile(canonical, "utf8");
  const aliases = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [keyword, ...parts] = line.split(/\s+/);
    if (keyword?.toLocaleLowerCase() === "host") {
      for (const value of parts) {
        if (!value.startsWith("!") && !/[?*]/.test(value) && /^[A-Za-z0-9._-]+$/.test(value)) aliases.add(value);
      }
      continue;
    }
    if (keyword?.toLocaleLowerCase() !== "include") continue;
    for (const include of parts) {
      const expanded = include.startsWith("~/")
        ? resolve(homedir(), include.slice(2))
        : isAbsolute(include) ? include : resolve(dirname(canonical), include);
      for await (const includedPath of glob(expanded)) {
        const nested = await collectConfigAliases(includedPath, visited);
        for (const alias of nested) aliases.add(alias);
      }
    }
  }
  return aliases;
}

export class OpenSshTransport implements RemoteTransport {
  constructor(
    private readonly configPath: string,
    private readonly sshPath = "/usr/bin/ssh",
  ) {}

  run(alias: string, script: string, timeoutMs: number): Promise<RemoteCommandResult> {
    return new Promise((resolveRun, reject) => {
      const child = spawn(this.sshPath, [
        "-F", this.configPath,
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=5",
        "--", validateAlias(alias), "sh", "-s",
      ], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        if (!settled) reject(new Error(`SSH command timed out after ${timeoutMs} ms`));
        settled = true;
      }, timeoutMs);
      const append = (current: Buffer, chunk: Buffer) => {
        const next = Buffer.concat([current, chunk]);
        if (next.length > MAX_SSH_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          throw new Error("SSH command output exceeded 2 MB");
        }
        return next;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        try { stdout = append(stdout, chunk); } catch (error) { if (!settled) reject(error); settled = true; }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        try { stderr = append(stderr, chunk); } catch (error) { if (!settled) reject(error); settled = true; }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        if (!settled) reject(error);
        settled = true;
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolveRun({ exitCode: code ?? 255, stderr: stderr.toString("utf8"), stdout: stdout.toString("utf8") });
      });
      child.stdin.end(script);
    });
  }
}

const PROBE_SCRIPT = `set +e
printf 'cpu='; getconf _NPROCESSORS_ONLN 2>/dev/null || true
printf 'memory_kib='; awk '/MemTotal:/ {print $2; exit}' /proc/meminfo 2>/dev/null || true
printf 'gpu='; if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n 1; else printf '\n'; fi
printf 'cuda='; if command -v nvcc >/dev/null 2>&1; then nvcc --version 2>/dev/null | awk '/release/ {print $5}' | tr -d ','; else printf '\n'; fi
printf 'conda='; if command -v conda >/dev/null 2>&1 || command -v micromamba >/dev/null 2>&1; then printf '1\n'; else printf '0\n'; fi
printf 'modules='; if command -v module >/dev/null 2>&1 || command -v modulecmd >/dev/null 2>&1; then printf '1\n'; else printf '0\n'; fi
printf 'containers='; found=''; for runtime in apptainer singularity docker podman; do if command -v "$runtime" >/dev/null 2>&1; then found="\${found}\${found:+,}$runtime"; fi; done; printf '%s\n' "$found"
printf 'scratch='; found=''; for path in /scratch /tmp "\${SCRATCH:-}"; do if [ -n "$path" ] && [ -d "$path" ] && [ -w "$path" ]; then found="\${found}\${found:+,}$path"; fi; done; printf '%s\n' "$found"
printf 'sbatch='; if command -v sbatch >/dev/null 2>&1; then printf '1\n'; else printf '0\n'; fi
`;

function parseProbe(stdout: string): RemoteHostCapabilities {
  const values = new Map(stdout.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf("=");
    return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
  }));
  const cpu = Number(values.get("cpu"));
  const memoryKib = Number(values.get("memory_kib"));
  return {
    conda: values.get("conda") === "1",
    containerRuntimes: values.get("containers")?.split(",").filter(Boolean) ?? [],
    cpuCores: Number.isSafeInteger(cpu) && cpu > 0 ? cpu : null,
    cuda: values.get("cuda")?.trim() || null,
    gpu: values.get("gpu")?.trim() || null,
    memoryBytes: Number.isSafeInteger(memoryKib) && memoryKib > 0 ? memoryKib * 1024 : null,
    modules: values.get("modules") === "1",
    probedAt: new Date().toISOString(),
    scratchPaths: [...new Set(values.get("scratch")?.split(",").filter(Boolean) ?? [])],
    slurm: values.get("sbatch") === "1",
  };
}

export class RemoteComputeClient {
  readonly transport: RemoteTransport;

  constructor(
    readonly sshConfigPath: string,
    transport?: RemoteTransport,
  ) {
    this.transport = transport ?? new OpenSshTransport(sshConfigPath);
  }

  async configuredAliases(): Promise<string[]> {
    return [...await collectConfigAliases(this.sshConfigPath)].toSorted();
  }

  async probe(aliasValue: string): Promise<RemoteHostCapabilities> {
    const alias = validateAlias(aliasValue);
    const aliases = await this.configuredAliases();
    if (!aliases.includes(alias)) throw new Error(`SSH host alias ${alias} is not explicitly present in the configured SSH config`);
    const result = await this.transport.run(alias, PROBE_SCRIPT, 20_000);
    if (result.exitCode !== 0) throw new Error(`SSH probe failed (${result.exitCode}): ${result.stderr.trim() || "authentication or connection failed"}`);
    return parseProbe(result.stdout);
  }

  async start(job: RemoteJob, workspaceRoot: string): Promise<RemoteJob> {
    const workingDirectory = validateRemotePath(job.card.remoteWorkingDirectory, "Remote working directory");
    const now = new Date().toISOString();
    if (job.card.mode === "slurm") {
      const partition = job.card.resources.partition;
      if (partition && !/^[A-Za-z0-9._-]{1,80}$/.test(partition)) throw new Error("SLURM partition contains unsupported characters");
      const batch = [
        "#!/bin/sh",
        `#SBATCH --cpus-per-task=${job.card.resources.cpus}`,
        `#SBATCH --mem=${job.card.resources.memoryMb}M`,
        `#SBATCH --time=${Math.floor(job.card.resources.walltimeMinutes / 60).toString().padStart(2, "0")}:${(job.card.resources.walltimeMinutes % 60).toString().padStart(2, "0")}:00`,
        ...(job.card.resources.gpus ? [`#SBATCH --gpus=${job.card.resources.gpus}`] : []),
        ...(partition ? [`#SBATCH --partition=${partition}`] : []),
        "set -eu",
        `cd -- ${shellQuote(workingDirectory)}`,
        job.card.command,
        "",
      ].join("\n");
      const scriptReference = `${workingDirectory}/.science-agent/jobs/${job.id}.sh`;
      const encoded = Buffer.from(batch).toString("base64");
      const submit = await this.transport.run(job.card.targetAlias, [
        "set -eu",
        `job_script=${shellQuote(scriptReference)}`,
        `mkdir -p -- ${shellQuote(dirname(scriptReference))}`,
        `printf '%s' ${shellQuote(encoded)} | base64 -d > "$job_script"`,
        "chmod 700 \"$job_script\"",
        "sbatch --parsable \"$job_script\"",
        "",
      ].join("\n"), 30_000);
      if (submit.exitCode !== 0) throw new Error(`SLURM submission failed (${submit.exitCode}): ${submit.stderr.trim() || submit.stdout.trim()}`);
      const remoteJobId = submit.stdout.trim().split(/[;\s]/)[0];
      if (!remoteJobId || !/^\d+(?:_\d+)?$/.test(remoteJobId)) throw new Error("SLURM did not return a valid job id");
      return {
        ...job,
        outputRecords: job.card.outputs.map((output) => ({
          ...output,
          status: output.disposition === "remote" ? "remote" : "pending",
        })),
        remoteJobId,
        scriptReference,
        startedAt: now,
        state: "submitted",
        stderr: submit.stderr.slice(0, 20_000),
        stdout: submit.stdout.slice(0, 20_000),
        updatedAt: now,
      };
    }

    const run = await this.transport.run(job.card.targetAlias, `set -eu\ncd -- ${shellQuote(workingDirectory)}\n${job.card.command}\n`, Math.min(job.card.resources.walltimeMinutes * 60_000, 24 * 60 * 60_000));
    const outputRecords = await this.collectOutputs(job, workspaceRoot);
    return {
      ...job,
      error: run.exitCode === 0 ? undefined : `Remote SSH command exited with ${run.exitCode}`,
      finishedAt: new Date().toISOString(),
      outputRecords,
      scriptReference: `inline:${job.id}`,
      startedAt: now,
      state: run.exitCode === 0 ? "completed" : "failed",
      stderr: run.stderr.slice(0, 20_000),
      stdout: run.stdout.slice(0, 20_000),
      updatedAt: new Date().toISOString(),
    };
  }

  async refresh(job: RemoteJob, workspaceRoot: string): Promise<RemoteJob> {
    if (job.card.mode !== "slurm" || !job.remoteJobId || !["submitted", "running"].includes(job.state)) return job;
    const status = await this.transport.run(job.card.targetAlias, [
      "set +e",
      `job_id=${shellQuote(job.remoteJobId)}`,
      "state=$(sacct -j \"$job_id\" --noheader --parsable2 --format=State 2>/dev/null | awk -F'|' 'NF {print $1; exit}')",
      "if [ -z \"$state\" ]; then state=$(squeue -h -j \"$job_id\" -o '%T' 2>/dev/null | head -n 1); fi",
      "printf '%s\\n' \"$state\"",
      "",
    ].join("\n"), 20_000);
    if (status.exitCode !== 0) throw new Error(`Could not refresh SLURM job: ${status.stderr.trim()}`);
    const remoteState = status.stdout.trim().split(/[+\s]/)[0]?.toLocaleUpperCase();
    if (remoteState === "COMPLETED") {
      return {
        ...job,
        finishedAt: new Date().toISOString(),
        outputRecords: await this.collectOutputs(job, workspaceRoot),
        state: "completed",
        updatedAt: new Date().toISOString(),
      };
    }
    if (["FAILED", "TIMEOUT", "CANCELLED", "NODE_FAIL", "OUT_OF_MEMORY"].includes(remoteState ?? "")) {
      return { ...job, error: `SLURM job ended in ${remoteState}`, finishedAt: new Date().toISOString(), state: "failed", updatedAt: new Date().toISOString() };
    }
    return { ...job, state: remoteState === "RUNNING" ? "running" : "submitted", updatedAt: new Date().toISOString() };
  }

  private async collectOutputs(job: RemoteJob, workspaceRoot: string): Promise<RemoteJobOutputRecord[]> {
    const records: RemoteJobOutputRecord[] = [];
    for (const [index, output] of job.card.outputs.entries()) {
      const path = validateRemotePath(output.path, "Remote output path");
      if (output.disposition === "remote") {
        records.push({ ...output, status: "remote" });
        continue;
      }
      const result = await this.transport.run(job.card.targetAlias, [
        "set -eu",
        `path=${shellQuote(path)}`,
        "if [ ! -f \"$path\" ]; then printf 'missing\\n'; exit 0; fi",
        "size=$(wc -c < \"$path\" | tr -d ' ')",
        `if [ "$size" -gt ${MAX_PULLED_OUTPUT_BYTES} ]; then printf 'remote|%s\\n' "$size"; exit 0; fi`,
        "printf 'file|%s|' \"$size\"",
        "base64 < \"$path\" | tr -d '\\n'",
        "printf '\\n'",
        "",
      ].join("\n"), 20_000);
      if (result.exitCode !== 0) throw new Error(`Could not inspect remote output ${path}: ${result.stderr.trim()}`);
      const [kind, rawSize, encoded] = result.stdout.trim().split("|", 3);
      const size = Number(rawSize);
      if (kind === "missing") {
        records.push({ ...output, status: "missing" });
      } else if (kind === "remote" || !Number.isSafeInteger(size) || size > MAX_PULLED_OUTPUT_BYTES) {
        records.push({ ...output, ...(Number.isSafeInteger(size) ? { size } : {}), status: "remote" });
      } else if (kind === "file" && encoded !== undefined) {
        const content = Buffer.from(encoded, "base64");
        if (content.length !== size) throw new Error(`Remote output size changed while pulling ${path}`);
        const safeName = basename(path).replaceAll(/[^A-Za-z0-9._-]/g, "_") || `output-${index}`;
        const localPath = `remote-outputs/${job.id}/${index}-${safeName}`;
        const target = resolve(workspaceRoot, localPath);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
        records.push({ ...output, localPath, size, status: "available" });
      } else {
        records.push({ ...output, status: "missing" });
      }
    }
    return records;
  }
}
