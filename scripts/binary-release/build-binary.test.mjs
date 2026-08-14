import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { buildSeaBlob, resolveSeaRuntimePlan, verifyNodeVersion } from "./build-binary.mjs";
import { loadManifest } from "./fetch-runtime.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const testRoot = join(repositoryRoot, ".tmp-binary-release-tests");

test("selects a pinned native generator for native and cross targets", async () => {
  const manifest = await loadManifest();
  const native = resolveSeaRuntimePlan(manifest, "x86_64", "linux", "x64");
  assert.equal(native.generatorArchitecture, "x86_64");
  assert.equal(native.generator.version, manifest.node.version);
  assert.equal(native.target.version, manifest.node.version);

  const cross = resolveSeaRuntimePlan(manifest, "aarch64", "linux", "x64");
  assert.equal(cross.generatorArchitecture, "x86_64");
  assert.equal(cross.targetArchitecture, "aarch64");
  assert.equal(cross.generator.version, cross.target.version);
});

test("rejects unsupported generator hosts before building", async () => {
  const manifest = await loadManifest();
  assert.throws(
    () => resolveSeaRuntimePlan(manifest, "x86_64", "darwin", "x64"),
    /only be built on Linux, not darwin/,
  );
  assert.throws(
    () => resolveSeaRuntimePlan(manifest, "x86_64", "linux", "riscv64"),
    /No pinned Node runtime can execute on build architecture riscv64/,
  );
});

test("requires an exact SEA generator Node version", async () => {
  const matchingRun = async () => ({ stdout: "v22.19.0\n" });
  assert.equal(await verifyNodeVersion("/runtime/node", "v22.19.0", matchingRun), "v22.19.0");

  await assert.rejects(
    verifyNodeVersion("/runtime/node", "v22.19.0", async () => ({ stdout: "v22.20.0\n" })),
    /expected v22\.19\.0 from runtimes\.json, got v22\.20\.0 from \/runtime\/node/,
  );
  await assert.rejects(
    verifyNodeVersion("/runtime/node", "v22.19.0", async () => {
      throw new Error("Exec format error");
    }),
    /Could not verify SEA generator Node at \/runtime\/node: Exec format error/,
  );
});

test("runs SEA generation with the selected Node executable", async () => {
  await mkdir(testRoot, { recursive: true });
  const workDirectory = await mkdtemp(join(testRoot, "sea-"));
  const bundlePath = join(workDirectory, "launcher.cjs");
  await writeFile(bundlePath, "console.log('launcher');\n");
  const calls = [];
  try {
    const blobPath = await buildSeaBlob(
      workDirectory,
      bundlePath,
      "/pinned/node/bin/node",
      async (...args) => {
        calls.push(args);
        await writeFile(join(workDirectory, "launcher.blob"), "blob");
        return { stdout: "", stderr: "" };
      },
    );
    assert.equal(blobPath, join(workDirectory, "launcher.blob"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "/pinned/node/bin/node");
    assert.equal(calls[0][1][0], "--experimental-sea-config");
    const config = JSON.parse(await readFile(join(workDirectory, "sea-config.json"), "utf8"));
    assert.equal(config.main, "launcher.cjs");
    assert.equal(config.output, "launcher.blob");
    assert.equal(config.useCodeCache, false);
    assert.equal(config.useSnapshot, false);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
});
