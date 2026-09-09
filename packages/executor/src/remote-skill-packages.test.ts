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
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { PermissionEpoch, ShellExecutionRequest, SkillPackageBundle } from "@sciencediscovery/schema";
import { skillBundleManifest } from "@sciencediscovery/runner";

import { RunnerClient } from "./runner-client.js";

/**
 * The remote Skill mount, proved against a second Runner started the way the
 * product starts one: its own process, its own data directory, reached only
 * over HTTP. Nothing here touches SSH — the tunnel is a transport detail, while
 * what has to hold is that a Runner which never shared a filesystem with the
 * control plane still mounts the selected frozen packages.
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TOKEN = "remote-skill-packages-token";

function epoch(): PermissionEpoch {
  return {
    createdAt: new Date().toISOString(),
    environmentRevisionId: "test-shell",
    id: "epoch-remote-skills",
    mounts: [{ mode: "read-write", source: "workspace" }],
    networkPolicy: "none",
    reason: "test",
    secretRefs: [],
    sessionId: "session-1",
  };
}

/** One selected frozen package, hashed exactly the way the catalog freezes it. */
function bundle(files: Record<string, string>, id = "selected", revision = 1): SkillPackageBundle {
  const packageHash = createHash("sha256");
  const entries = Object.entries(files).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const packaged = entries.map(([path, text]) => {
    const bytes = Buffer.from(text);
    packageHash.update(`${Buffer.byteLength(path)}:${path}:${bytes.length}:`).update(bytes);
    return {
      content: bytes.toString("base64"),
      hash: createHash("sha256").update(bytes).digest("hex"),
      path,
      size: bytes.length,
    };
  });
  return { skills: [{ files: packaged, hash: packageHash.digest("hex"), id, revision, version: "1" }] };
}

/** One selected set built from several packages. */
function selection(...packages: SkillPackageBundle[]): SkillPackageBundle {
  return { skills: packages.flatMap((one) => one.skills) };
}

const SELECTED = {
  "SKILL.md": "Frozen instructions\n",
  "scripts/check.sh": "printf 'checked %s\\n' \"$1\"\nexit 7\n",
};

async function startRemoteRunner(context: { after: (callback: () => Promise<void> | void) => void }) {
  const dataDir = resolve(repositoryRoot, ".tmp", `remote-skill-runner-${process.pid}-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  const child = spawn(process.execPath, [resolve(repositoryRoot, "services/runner/dist/server.js")], {
    env: {
      ...process.env,
      SCIENCE_AGENT_DATA_DIR: dataDir,
      SCIENCE_AGENT_RUNNER_PORT: "0",
      SCIENCE_AGENT_RUNNER_TOKEN: TOKEN,
      SCIENTIFIC_ENVS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(async () => {
    child.kill("SIGKILL");
    await new Promise((done) => child.once("exit", done));
    await rm(dataDir, { force: true, recursive: true });
  });
  const port = await new Promise<number>((ready, failed) => {
    let output = "";
    const deadline = setTimeout(() => failed(new Error(`Runner did not start in time:\n${output}`)), 60_000);
    const inspect = (chunk: Buffer) => {
      output += chunk.toString();
      const listening = /listening on http:\/\/[^:]+:(\d+)/.exec(output);
      if (!listening) return;
      clearTimeout(deadline);
      ready(Number(listening[1]));
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code) => {
      clearTimeout(deadline);
      failed(new Error(`Runner exited with ${code}:\n${output}`));
    });
  });
  return { client: new RunnerClient(`http://127.0.0.1:${port}`, TOKEN), dataDir };
}

/**
 * A control-plane workspace path: it does not exist on the Runner, so an
 * execution only succeeds because the Runner resolves its own workspace and
 * mounts its own copy of the packages.
 */
function shell(code: string, executionId: string, skillPackagesRoot: string): ShellExecutionRequest {
  return {
    agentId: "main",
    code,
    executionId,
    permissionEpoch: epoch(),
    runnerWorkspaceKey: "project-1/session-1",
    skillPackagesRoot,
    workspaceRoot: resolve(repositoryRoot, ".tmp", "control-plane-only", "workspace"),
  };
}

test("a second Runner mounts the selected packages it was sent and runs scripts out of them", async (context) => {
  const remote = await startRemoteRunner(context);
  // An earlier run put a wider set on this Runner, so the Skill dropped from
  // the selection really is present in its store and only absent from the tree
  // this run mounts.
  const earlier = selection(bundle(SELECTED), bundle({ "SKILL.md": "Dropped\n" }, "unselected"));
  await remote.client.prepareSkillPackages(skillBundleManifest(earlier), async () => earlier);

  const selected = bundle(SELECTED);
  const root = await remote.client.prepareSkillPackages(skillBundleManifest(selected), async () => selected);

  // The mount path is the Runner's own; no control-plane absolute path travels.
  assert.ok(root.startsWith(resolve(remote.dataDir, "projects", ".skill-packages")), root);

  const result = await remote.client.executeShell(shell([
    'ls "$SCIENCEDISCOVERY_SKILLS_DIR"',
    'sh "$SCIENCEDISCOVERY_SKILLS_DIR/selected/scripts/check.sh" remotely',
  ].join("\n"), "remote-skill-script", root));

  // The real exit code and output of the packaged script, not a re-evaluation,
  // and nothing on the Skill tree but what this run selected.
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, "selected\nchecked remotely\n");

  // A Runner that already holds the set is not sent the bytes again.
  const cached = await remote.client.prepareSkillPackages(skillBundleManifest(selected), async () => {
    throw new Error("bytes were shipped to a Runner that already held them");
  });
  assert.equal(cached, root);
});

test("a changed selection or revision gets its own tree instead of reusing a stale one", async (context) => {
  const remote = await startRemoteRunner(context);
  const first = bundle(SELECTED);
  const root = await remote.client.prepareSkillPackages(skillBundleManifest(first), async () => first);

  // Same Skill, new frozen revision: a different tree, with the new script.
  const revised = bundle({ ...SELECTED, "scripts/check.sh": "printf 'revised\\n'\n" }, "selected", 2);
  const revisedRoot = await remote.client.prepareSkillPackages(skillBundleManifest(revised), async () => revised);
  assert.notEqual(revisedRoot, root);
  const afterRevision = await remote.client.executeShell(
    shell('sh "$SCIENCEDISCOVERY_SKILLS_DIR/selected/scripts/check.sh"', "remote-skill-revised", revisedRoot),
  );
  assert.equal(afterRevision.exitCode, 0);
  assert.match(afterRevision.stdout, /^revised$/m);

  // A different selected Skill is a different tree too, and the Skill dropped
  // from the selection is not in it.
  const other = bundle({ "SKILL.md": "Another package\n" }, "other");
  const otherRoot = await remote.client.prepareSkillPackages(skillBundleManifest(other), async () => other);
  assert.notEqual(otherRoot, root);
  const afterSwap = await remote.client.executeShell(
    shell('ls "$SCIENCEDISCOVERY_SKILLS_DIR"', "remote-skill-swap", otherRoot),
  );
  assert.deepEqual(afterSwap.stdout.trim().split("\n"), ["other"]);
});

test("a failed sync or a damaged remote tree fails the execution instead of pretending", async (context) => {
  const remote = await startRemoteRunner(context);
  const selected = bundle(SELECTED);

  // Bytes that do not add up to the manifest never become a mountable tree.
  const tampered = bundle(SELECTED);
  tampered.skills[0]!.files[0]!.content = Buffer.from("tampered").toString("base64");
  await assert.rejects(
    remote.client.prepareSkillPackages(skillBundleManifest(selected), async () => tampered),
    /Remote Skill preparation failed.*integrity/s,
  );

  // A Runner that cannot be reached fails the execution rather than letting it
  // run with no Skills mounted.
  const unreachable = new RunnerClient("http://127.0.0.1:1", TOKEN);
  await assert.rejects(
    unreachable.prepareSkillPackages(skillBundleManifest(selected), async () => selected),
    /Remote Skill preparation failed/,
  );

  // A published tree damaged afterwards stops being mountable.
  const root = await remote.client.prepareSkillPackages(skillBundleManifest(selected), async () => selected);
  const script = resolve(root, "selected", "scripts", "check.sh");
  await rm(script);
  await writeFile(script, "echo tampered\n");
  await assert.rejects(
    remote.client.executeShell(shell("echo unreachable", "remote-skill-damaged", root)),
    /integrity/,
  );
});
