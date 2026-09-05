#!/usr/bin/env node
// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { packRunnerBundle } from "../../packages/executor/dist/runner-bundle.js";
import { fetchNodeBinary, injectBlob, resolveSeaRuntimePlan, verifyNodeVersion } from "./build-binary.mjs";
import { loadManifest } from "./fetch-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const run = promisify(execFile);

/** Convert our deterministic ustar tree into a self-extracting SEA asset. */
export function runnerAsset(archive) {
  const tar = gunzipSync(archive);
  const files = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (!header.some(Boolean)) break;
    const text = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, "");
    const size = parseInt(text(124, 12), 8);
    const path = [text(345, 155), text(0, 100)].filter(Boolean).join("/");
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length || path.startsWith("/") || path.split("/").includes("..")) throw new Error("Invalid runner archive");
    files.push({ path, content: tar.subarray(offset + 512, offset + 512 + size).toString("base64") });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return gzipSync(JSON.stringify(files), { level: 9 });
}

export async function buildRunner(architectures = ["x86_64", "aarch64"]) {
  const manifest = await loadManifest();
  const bundle = await packRunnerBundle();
  const bootstrap = await readFile(join(root, "scripts/binary-release/runner-main.cjs"));
  const sourceId = createHash("sha256").update(bundle.id).update(bootstrap).update(JSON.stringify(manifest.node)).digest("hex");
  const workRoot = join(root, ".tmp/runner-sea-build");
  await mkdir(workRoot, { recursive: true });
  for (const arch of architectures) {
    const plan = resolveSeaRuntimePlan(manifest, arch);
    const targetArch = plan.targetArchitecture === "x86_64" ? "x64" : "arm64";
    const outputDir = join(root, "services/runner/dist/sea", `linux-${targetArch}`);
    const output = join(outputDir, "sciencediscovery-runner");
    const metadataPath = `${output}.json`;
    try {
      const old = JSON.parse(await readFile(metadataPath, "utf8"));
      if (old.sourceId === sourceId && createHash("sha256").update(await readFile(output)).digest("hex") === old.id) {
        console.log(`Runner SEA linux-${targetArch}: unchanged`); continue;
      }
    } catch { /* First build or stale output. */ }
    const stage = await mkdtemp(join(workRoot, "build-"));
    try {
      const targetNode = await fetchNodeBinary(arch, stage);
      const generator = arch === plan.generatorArchitecture ? targetNode : await fetchNodeBinary(plan.generatorArchitecture, stage);
      await verifyNodeVersion(generator, plan.target.version);
      await writeFile(join(stage, "main.cjs"), bootstrap);
      await writeFile(join(stage, "runner.gz"), runnerAsset(bundle.archive));
      await writeFile(join(stage, "sea.json"), JSON.stringify({ main: "main.cjs", output: "runner.blob", assets: { runner: "runner.gz" }, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
      await run(generator, ["--experimental-sea-config", "sea.json"], { cwd: stage });
      const executable = join(stage, "runner");
      await copyFile(targetNode, executable);
      await injectBlob(executable, join(stage, "runner.blob"));
      await chmod(executable, 0o755);
      const bytes = await readFile(executable);
      const metadata = { sourceId, architecture: targetArch, id: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
      await mkdir(outputDir, { recursive: true });
      await rename(executable, output);
      await writeFile(metadataPath, JSON.stringify(metadata) + "\n");
      console.log(`Runner SEA linux-${targetArch}: ${bytes.length} bytes`);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--arch" || !["x86_64", "aarch64"].includes(args[1]))) throw new Error("Usage: build-runner.mjs [--arch x86_64|aarch64]");
  await buildRunner(args.length ? [args[1]] : undefined);
}
