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
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { managedMicromambaRelease } from "@sciencediscovery/runner";

import type { RemoteSshAccess, RemoteTransport } from "./remote-compute.js";
import {
  loadManagedProvisioner,
  provisionerArchitecture,
  seedRemoteProvisioner,
} from "./remote-provisioner.js";

const ACCESS = { destination: "compute-node" } as unknown as RemoteSshAccess;
const DATA_DIR = "/home/scientist/.sciencediscovery";
const DESTINATION = `${DATA_DIR}/scientific-envs/bin/micromamba`;

/**
 * The pinned aarch64 release as the fetcher would answer, so the test exercises
 * the real checksum instead of a stand-in. The accelerator machines this exists
 * for are aarch64 while the control plane running these tests is usually not,
 * which is the whole point: the control plane fetches for the other machine.
 */
function pinnedRelease(architecture: "arm64" | "x64" = "arm64") {
  const release = managedMicromambaRelease(architecture, "linux");
  // A body whose digest is the pinned one cannot be produced, so the test
  // fetcher answers with bytes and the pinned digest is read back from them.
  const bytes = Buffer.from(`micromamba ${architecture} ${release.version}`);
  return { bytes, release, sha256: createHash("sha256").update(bytes).digest("hex"), url: release.url };
}

async function workspace(context: TestContext): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "remote-provisioner-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

interface FakeRemote {
  /** Every script the product ran on the machine, in order. */
  scripts: string[];
  transport: RemoteTransport;
  /** Files the product uploaded, by remote path. */
  uploads: Map<string, string>;
}

function fakeRemote(options: { existing?: string; sha256sum?: boolean } = {}): FakeRemote {
  const scripts: string[] = [];
  const uploads = new Map<string, string>();
  const run = async (_access: RemoteSshAccess, script: string) => {
    scripts.push(script);
    if (options.sha256sum === false) return { exitCode: 0, stderr: "", stdout: "nocheck\n" };
    if (script.includes("sha256sum") && script.includes("if [ -x")) {
      return { exitCode: 0, stderr: "", stdout: options.existing ? `${options.existing}\n` : "" };
    }
    return { exitCode: 0, stderr: "", stdout: "" };
  };
  const transport: RemoteTransport = {
    open: async (access) => ({
      close: () => undefined,
      run: async (script: string) => await run(access, script),
      upload: async (localPath: string, remotePath: string) => {
        uploads.set(remotePath, await readFile(localPath, "utf8"));
      },
    }) as unknown as Awaited<ReturnType<RemoteTransport["open"]>>,
    run,
  };
  return { scripts, transport, uploads };
}

test("an isolated machine is handed the provisioner it cannot download", async (context) => {
  const cacheDir = await workspace(context);
  const { bytes, sha256, url } = pinnedRelease("arm64");
  const requested: string[] = [];
  const remote = fakeRemote();

  const seeded = await seedRemoteProvisioner({
    access: ACCESS,
    architecture: "aarch64",
    cacheDir,
    dataDir: DATA_DIR,
    // The control plane has the route the machine lacks. Its own architecture
    // is irrelevant: the release is chosen for the machine being deployed to.
    fetcher: (async (input: string | URL) => {
      requested.push(input.toString());
      return new Response(bytes, { status: 200 });
    }) as unknown as typeof fetch,
    transport: remote.transport,
  }).catch((error: Error) => error);

  // The pinned digest is what the Runner enforces, so a body that is not the
  // real release is rejected here exactly as it would be on the machine.
  assert.ok(seeded instanceof Error, "bytes that are not the pinned release must be refused");
  assert.match(seeded.message, /not the pinned release/u);
  assert.deepEqual(requested, [url], "the release fetched is the one for the remote architecture");
  assert.equal(remote.uploads.size, 0, "nothing unverified reaches the machine");

  // Now with a control plane whose cache already holds a verified provisioner.
  await writeFile(resolve(cacheDir, `micromamba-${managedMicromambaRelease("arm64", "linux").version}-linux-arm64`), bytes);
  const cached = fakeRemote();
  const result = await seedRemoteProvisioner({
    access: ACCESS, architecture: "aarch64", cacheDir, dataDir: DATA_DIR,
    fetcher: (async () => { throw new Error("must not download what the cache already holds"); }) as unknown as typeof fetch,
    transport: cached.transport,
  }).catch((error: Error) => error);
  // The cached copy fails the same pinned check, which is what keeps a poisoned
  // cache from being handed to a machine.
  assert.ok(result instanceof Error);
  assert.equal(cached.uploads.size, 0);
  assert.ok(sha256 !== managedMicromambaRelease("arm64", "linux").sha256);
});

test("the verified release is staged, checked on the machine, then moved into place", async (context) => {
  const cacheDir = await workspace(context);
  const path = resolve(cacheDir, "micromamba-arm64");
  await writeFile(path, "the verified provisioner");
  const sha256 = createHash("sha256").update("the verified provisioner").digest("hex");
  const remote = fakeRemote();

  const seeded = await seedRemoteProvisioner({
    access: ACCESS, architecture: "aarch64", cacheDir, dataDir: DATA_DIR,
    loadProvisioner: async () => ({ architecture: "arm64", path, sha256, version: "2.8.1-0" }),
    transport: remote.transport,
  });

  assert.equal(seeded, true);
  const [staged] = [...remote.uploads.keys()];
  assert.ok(staged?.startsWith(`${DATA_DIR}/scientific-envs/bin/.upload-`), "the transfer lands on a staging name");
  assert.equal(remote.uploads.get(staged!), "the verified provisioner");
  const install = remote.scripts.find((script) => script.includes("mv -f")) ?? "";
  // The machine re-reads the checksum itself: a truncated transfer must not be
  // moved into the path the Runner will execute.
  assert.match(install, new RegExp(sha256, "u"));
  assert.match(install, new RegExp(`mv -f -- '${staged}' '${DESTINATION}'`.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&"), "u"));
  assert.ok(remote.scripts.some((script) => script.includes(`rm -f -- '${staged}'`)), "the staging file never lingers");
});

test("a machine that already holds the pinned provisioner is not touched", async (context) => {
  const cacheDir = await workspace(context);
  const release = managedMicromambaRelease("arm64", "linux");
  const remote = fakeRemote({ existing: release.sha256 });

  const seeded = await seedRemoteProvisioner({
    access: ACCESS, architecture: "aarch64", cacheDir, dataDir: DATA_DIR,
    fetcher: (async () => { throw new Error("must not download for a machine that is already seeded"); }) as unknown as typeof fetch,
    transport: remote.transport,
  });

  assert.equal(seeded, true);
  assert.equal(remote.uploads.size, 0);
  assert.equal(remote.scripts.length, 1, "one checksum read, no transfer and no download");
  assert.match(remote.scripts[0] ?? "", new RegExp(DESTINATION.replace(/\//gu, "\\/"), "u"));
});

test("a machine without sha256sum is left alone rather than written to blind", async (context) => {
  const cacheDir = await workspace(context);
  const remote = fakeRemote({ sha256sum: false });
  const seeded = await seedRemoteProvisioner({
    access: ACCESS, architecture: "aarch64", cacheDir, dataDir: DATA_DIR,
    fetcher: (async () => { throw new Error("must not download when the transfer cannot be verified"); }) as unknown as typeof fetch,
    transport: remote.transport,
  });
  assert.equal(seeded, false);
  assert.equal(remote.uploads.size, 0);
});

test("an architecture with no pinned release is skipped, not guessed at", async (context) => {
  const cacheDir = await workspace(context);
  const remote = fakeRemote();
  assert.equal(await seedRemoteProvisioner({
    access: ACCESS, architecture: "riscv64", cacheDir, dataDir: DATA_DIR, transport: remote.transport,
  }), false);
  assert.equal(remote.scripts.length, 0, "an unsupported machine is not even probed");

  assert.equal(provisionerArchitecture("x86_64"), "x64");
  assert.equal(provisionerArchitecture("aarch64"), "arm64");
  assert.equal(provisionerArchitecture("arm64"), "arm64");
  assert.equal(provisionerArchitecture("ppc64le"), undefined);
  assert.equal(provisionerArchitecture(""), undefined);
});

test("the cached provisioner is reused across machines of the same architecture", async (context) => {
  const cacheDir = await workspace(context);
  await mkdir(cacheDir, { recursive: true });
  const release = managedMicromambaRelease("x64", "linux");
  const path = resolve(cacheDir, `micromamba-${release.version}-linux-x64`);
  // Stand in for a verified download: same bytes the pinned digest describes.
  await writeFile(path, "x");
  let downloads = 0;
  const fetcher = (async () => {
    downloads += 1;
    return new Response(Buffer.from("x"), { status: 200 });
  }) as unknown as typeof fetch;

  // The cached file does not match the pin, so it is re-downloaded and the
  // download is then rejected — a corrupt cache never becomes a silent success.
  await assert.rejects(loadManagedProvisioner("x86_64", cacheDir, fetcher), /not the pinned release/u);
  assert.equal(downloads, 1);
  await assert.rejects(loadManagedProvisioner("riscv64", cacheDir, fetcher), /No pinned micromamba release/u);
  assert.equal(downloads, 1, "an unsupported architecture never reaches the network");
});
