// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVOLVE_RELEASE, EVOLVE_REQUIREMENTS } from "./evolve-lock.js";
import { resolveEvolveInstallation, evolveInstallRoot, type EvolveInstallContext } from "./evolve-install.js";
import type { BootstrapIo } from "./bootstrap.js";

async function fixture(action: (context: EvolveInstallContext, calls: string[]) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), "evolve-install-test-"));
  const calls: string[] = [];
  const io: BootstrapIo = {
    fetch: async () => { calls.push("fetch"); return new Response("truncated archive"); },
    findExecutable: async () => "/fixture/uv",
    log: () => {},
    run: async (_command, args) => { calls.push(args[0]!); return { stdout: "", stderr: "" }; },
  };
  const context: EvolveInstallContext = { dataDir, payloadRoot: "/fixture/payload", env: { SCIENCE_AGENT_UV_PATH: "/fixture/uv" }, log: () => {}, io,
    manifest: { formatVersion: 2, version: "fixture", product: "sciencediscovery", architecture: "x86_64", runtimeArchitecture: "x64", python: { version: "3.12.13", path: "python/bin/python3", sitePackages: "unused" },
      node: { version: "fixture", path: "node" }, app: { root: "app", apiEntry: "api", runnerEntry: "runner", webDir: "web" },
      bootstrap: { requirementsPath: "unused", gatewayWheelPath: "unused", uv: { version: "fixture", project: "uv", wheelFilename: "fixture", wheelSha256: "fixture" } } } };
  try { await action(context, calls); } finally { await rm(dataDir, { recursive: true, force: true }); }
}
async function seedInstalled(context: EvolveInstallContext) {
  const root = evolveInstallRoot(context);
  await mkdir(join(root, "venv/bin"), { recursive: true });
  await symlink(process.execPath, join(root, "venv/bin/python"));
  await writeFile(join(root, ".evolve-install.json"), JSON.stringify({ archive: EVOLVE_RELEASE.sha256, requirements: EVOLVE_RELEASE.requirementsSha256 }));
}
test("release identity and frozen runtime lock are exact and checksum verified", () => {
  assert.equal(EVOLVE_RELEASE.commit, "844947da87b27528d9a34d0ee6d0efd591e57749");
  assert.equal(EVOLVE_RELEASE.bytes, 32145323);
  assert.equal(EVOLVE_RELEASE.sha256, "2cea0ea513eef43c94e697e72a21cf7bb3d4b8883117479240b6c8d3e0cc2e99");
  assert.equal(createHash("sha256").update(EVOLVE_REQUIREMENTS).digest("hex"), EVOLVE_RELEASE.requirementsSha256);
  assert.match(EVOLVE_REQUIREMENTS, /^numpy==/m); assert.match(EVOLVE_REQUIREMENTS, /^pytest==/m);
  assert(!EVOLVE_REQUIREMENTS.includes("-e ."));
});
test("uninitialized restore does not resolve/download/install any dependency", async () => fixture(async (context, calls) => {
  assert.equal(await resolveEvolveInstallation(context), undefined); assert.deepEqual(calls, []);
}));
test("truncated, oversized, HTTP-error and same-sized checksum-mismatch archives fail without promotion and permit retry", async () => fixture(async (context) => {
  const io = context.io!;
  for (const response of [
    () => new Response("bad"), () => new Response(new Uint8Array(EVOLVE_RELEASE.bytes + 1)),
    () => new Response("bad", { status: 503 }), () => new Response(new Uint8Array(EVOLVE_RELEASE.bytes)),
  ]) {
    io.fetch = async () => response();
    await assert.rejects(resolveEvolveInstallation(context, true), /archive/);
    assert.equal((await readdir(join(context.dataDir, "evolve"))).some(name => name.startsWith(".install-")), false);
    assert.equal(await resolveEvolveInstallation(context), undefined);
  }
}));
test("missing runtime metadata, interpreter failure and cancellation stop before download", async () => fixture(async (context, calls) => {
  const bootstrap = context.manifest.bootstrap;
  context.manifest.bootstrap = undefined;
  await assert.rejects(resolveEvolveInstallation(context, true), /payload/);
  context.manifest.bootstrap = bootstrap;
  context.io!.run = async () => { throw new Error("unsupported interpreter"); };
  await assert.rejects(resolveEvolveInstallation(context, true), /unsupported interpreter/);
  assert(!calls.includes("fetch"));
  const controller = new AbortController(); controller.abort(); context.signal = controller.signal;
  await assert.rejects(resolveEvolveInstallation(context, true), { name: "AbortError" });
}));
test("installed runtime restores one per-install token under concurrency with private permissions and no network", async () => fixture(async (context, calls) => {
  await seedInstalled(context);
  const [first, second] = await Promise.all([resolveEvolveInstallation(context), resolveEvolveInstallation(context)]);
  assert(first); assert(second); assert(first.token === second.token, "concurrent restores must reuse the same private credential"); assert.match(first.token, /^[\w-]{43}$/);
  const secret = join(context.dataDir, "evolve/secrets/internal-token");
  assert.equal((await stat(secret)).mode & 0o777, 0o600);
  assert.equal((await stat(join(context.dataDir, "evolve/secrets"))).mode & 0o777, 0o700);
  assert((await resolveEvolveInstallation(context, true))!.token === first.token, "Init must reuse the installation credential");
  assert(calls.every(call => call === "-I"));
  const other = await mkdtemp(join(tmpdir(), "evolve-other-"));
  try { const otherContext = { ...context, dataDir: other }; await seedInstalled(otherContext);
    assert((await resolveEvolveInstallation(otherContext))!.token !== first.token, "separate installs require independent credentials");
  } finally { await rm(other, { recursive: true, force: true }); }
  await writeFile(secret, "not a token"); await assert.rejects(resolveEvolveInstallation(context), /credential/);
  await writeFile(secret, "x".repeat(129)); await assert.rejects(resolveEvolveInstallation(context), /credential/);
}));
test("managed directories and token symlinks are refused rather than followed", async () => fixture(async (context) => {
  await seedInstalled(context);
  await mkdir(join(context.dataDir, "evolve/secrets"));
  const outside = join(context.dataDir, "outside"); await writeFile(outside, "must not change");
  await symlink(outside, join(context.dataDir, "evolve/secrets/internal-token"));
  await assert.rejects(resolveEvolveInstallation(context));
  assert.equal(await readFile(outside, "utf8"), "must not change");
}));
test("offline frozen dependency export matches the shipped lock byte for byte", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const cwd = fileURLToPath(new URL("../../../", import.meta.url));
  const result = await promisify(execFile)("uv", ["export", "--project", "services/evolve", "--frozen", "--offline", "--extra", "candidates", "--no-dev", "--no-emit-project", "--no-header", "--format", "requirements-txt"], { cwd, timeout: 10_000 });
  assert.equal(result.stdout, EVOLVE_REQUIREMENTS);
});
test("credential promotion failure never activates a partial token and a later retry recovers", async () => fixture(async (context) => {
  await seedInstalled(context);
  const secrets = join(context.dataDir, "evolve/secrets"); await mkdir(secrets);
  await mkdir(join(secrets, ".internal-token.pending"));
  await assert.rejects(resolveEvolveInstallation(context));
  assert.equal(await readFile(join(secrets, "internal-token"), "utf8"), "");
  await rm(join(secrets, ".internal-token.pending"), { recursive: true });
  const recovered = await resolveEvolveInstallation(context); assert(recovered);
  assert.match(recovered.token, /^[\w-]{43}$/);
  assert(!(await readdir(secrets)).includes(".internal-token.pending"));
}));
