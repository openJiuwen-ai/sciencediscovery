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

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import type { RemoteJob } from "@sciencediscovery/schema";

import { RemoteComputeClient, type RemoteCommandResult, type RemoteTransport } from "@sciencediscovery/executor";

class FakeTransport implements RemoteTransport {
  readonly calls: Array<{ alias: string; script: string; timeoutMs: number }> = [];

  constructor(private readonly results: RemoteCommandResult[]) {}

  async run(alias: string, script: string, timeoutMs: number): Promise<RemoteCommandResult> {
    this.calls.push({ alias, script, timeoutMs });
    const result = this.results.shift();
    if (!result) throw new Error("Unexpected remote command");
    return result;
  }
}

function job(mode: "slurm" | "ssh"): RemoteJob {
  const timestamp = "2026-07-15T00:00:00.000Z";
  return {
    approvedAt: timestamp,
    card: {
      command: "python analysis.py --input /scratch/study/raw.parquet --output /scratch/study/summary.csv",
      inputPaths: ["/scratch/study/raw.parquet"],
      mode,
      outputs: [
        { disposition: "pull", path: "/scratch/study/summary.csv" },
        { disposition: "remote", path: "/scratch/study/large-model.bin" },
      ],
      remoteWorkingDirectory: "/scratch/study",
      resources: { cpus: 4, gpus: 0, memoryMb: 8_192, walltimeMinutes: 30 },
      targetAlias: "cluster",
      targetId: "host-1",
    },
    createdAt: timestamp,
    id: "job-1",
    outputRecords: [],
    scriptReference: "pending:job-1",
    sessionId: "session-1",
    state: "approved",
    updatedAt: timestamp,
    version: 2,
  };
}

test("SSH config aliases gate a read-only capability probe", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `remote-probe-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  context.after(() => rm(root, { force: true, recursive: true }));
  const configPath = resolve(root, "config");
  await writeFile(configPath, "Host cluster\n  HostName hpc.example.test\nHost *\n  BatchMode yes\n");
  const transport = new FakeTransport([{
    exitCode: 0,
    stderr: "",
    stdout: "cpu=32\nmemory_kib=65536\ngpu=NVIDIA A100\ncuda=12.4\nconda=1\nmodules=1\ncontainers=apptainer\nscratch=/scratch,/tmp\nsbatch=1\n",
  }]);
  const client = new RemoteComputeClient(configPath, transport);

  assert.deepEqual(await client.configuredAliases(), ["cluster"]);
  const capabilities = await client.probe("cluster");
  assert.equal(capabilities.cpuCores, 32);
  assert.equal(capabilities.memoryBytes, 64 * 1024 * 1024);
  assert.equal(capabilities.slurm, true);
  assert.deepEqual(capabilities.scratchPaths, ["/scratch", "/tmp"]);
  assert.doesNotMatch(transport.calls[0]!.script, /\b(?:mkdir|rm|touch)\b|\bsbatch\s+--/);
  await assert.rejects(client.probe("unlisted-host"), /not explicitly present/);
});

test("direct SSH jobs pull only small requested outputs and leave large data remote", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `remote-run-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  context.after(() => rm(root, { force: true, recursive: true }));
  const transport = new FakeTransport([
    { exitCode: 0, stderr: "warning", stdout: "analysis complete\n" },
    { exitCode: 0, stderr: "", stdout: "file|4|ZGF0YQ==\n" },
  ]);
  const completed = await new RemoteComputeClient(resolve(root, "config"), transport).start(job("ssh"), root);

  assert.equal(completed.state, "completed");
  assert.deepEqual(completed.outputRecords.map((output) => output.status), ["available", "remote"]);
  assert.equal(await readFile(resolve(root, completed.outputRecords[0]!.localPath!), "utf8"), "data");
  assert.match(transport.calls[0]!.script, /\/scratch\/study\/raw\.parquet/);
  assert.equal(transport.calls.some((call) => call.script.includes("large-model.bin")), false);
});

test("SLURM submission records the scheduler id and remote script without waiting for bulk outputs", async () => {
  const transport = new FakeTransport([{ exitCode: 0, stderr: "", stdout: "8421;cluster\n" }]);
  const submitted = await new RemoteComputeClient("/unused/config", transport).start(job("slurm"), "/unused/workspace");

  assert.equal(submitted.state, "submitted");
  assert.equal(submitted.remoteJobId, "8421");
  assert.equal(submitted.scriptReference, "/scratch/study/.sciencediscovery/jobs/job-1.sh");
  assert.deepEqual(submitted.outputRecords.map((output) => output.status), ["pending", "remote"]);
  assert.match(transport.calls[0]!.script, /sbatch --parsable/);
});
