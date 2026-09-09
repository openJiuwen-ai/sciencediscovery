// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { SkillPackageBundle } from "@sciencediscovery/schema";
import { RunnerSkillPackages, skillBundleIdentity } from "./skill-packages.js";
import { resolveSandboxSkillRoots } from "./executor.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** A Runner data directory of this test's own, inside the repository temp root. */
async function dataDir(prefix: string): Promise<string> {
  await mkdir(resolve(process.cwd(), ".tmp"), { recursive: true });
  return mkdtemp(resolve(process.cwd(), ".tmp", prefix));
}
function bundle(id = "selected", revision = 1, script = "echo frozen\n"): SkillPackageBundle {
  const data = new Map([["SKILL.md", Buffer.from("Selected package")], ["scripts/check.sh", Buffer.from(script)],
    ["assets/data.bin", Buffer.from([0, 255, 10])]]);
  const hash = createHash("sha256");
  for (const path of [...data.keys()].sort()) {
    const bytes = data.get(path)!;
    hash.update(`${Buffer.byteLength(path)}:${path}:${bytes.length}:`).update(bytes);
  }
  return { skills: [{ id, revision, version: "1", hash: hash.digest("hex"),
    files: [...data].map(([path, bytes]) => ({ path, size: bytes.length, hash: digest(bytes), content: bytes.toString("base64") })) }] };
}

test("whole selected bundles are immutable, binary-safe and keyed by set/revision/content", async (t) => {
  const dir = await dataDir("skill-bundles-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RunnerSkillPackages(dir);
  const original = bundle();
  const [first, concurrent] = await Promise.all([store.put(original), store.put(original)]);
  assert.deepEqual(concurrent, first);
  assert.deepEqual(await store.get(first.id), first);
  assert.deepEqual(await readFile(resolve(first.root, "selected/assets/data.bin")), Buffer.from([0, 255, 10]));
  assert.deepEqual((await readdir(first.root)).sort(), [".skill-bundle.json", "selected"]);
  for (const updated of [bundle("other"), bundle("selected", 2), bundle("selected", 1, "echo changed\n")]) {
    const next = await store.put(updated);
    assert.notEqual(next.root, first.root);
  }
  assert.equal(await readFile(resolve(first.root, "selected/scripts/check.sh"), "utf8"), "echo frozen\n");
  const workspace = resolve(dir, "projects/workspace");
  await mkdir(workspace);
  assert.equal((await resolveSandboxSkillRoots(dir, workspace, first.root))?.packagesRoot, first.root);
  assert.deepEqual(await readdir(workspace), [".sciencediscovery"]);
});

test("invalid paths, duplicate selections and mismatched frozen bytes fail before publication", async (t) => {
  const dir = await dataDir("skill-invalid-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RunnerSkillPackages(dir);
  for (const path of ["../escape", "/absolute", "a//b", "a/./b", "a\\b", "a\0b"]) {
    const invalid = bundle(); invalid.skills[0]!.files[0]!.path = path;
    await assert.rejects(store.put(invalid), /path/);
  }
  const corrupt = bundle(); corrupt.skills[0]!.files[0]!.content = Buffer.from("wrong").toString("base64");
  await assert.rejects(store.put(corrupt), /integrity/);
  const wrongHash = bundle(); wrongHash.skills[0]!.hash = "0".repeat(64);
  await assert.rejects(store.put(wrongHash), /integrity/);
  const duplicate = bundle(); duplicate.skills.push(duplicate.skills[0]!);
  await assert.rejects(store.put(duplicate), /metadata/);
  assert.deepEqual(await readdir(dir), []);
});

test("aborted staging is never published or mountable; corruption and symlinks fail closed", async (t) => {
  const dir = await dataDir("skill-closed-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RunnerSkillPackages(dir);
  const source = bundle();
  await assert.rejects(store.put(source, AbortSignal.abort()), /abort/i);
  assert.deepEqual(await store.get(skillBundleIdentity(source)), { id: skillBundleIdentity(source) });
  assert.deepEqual(await readdir(resolve(dir, ".skill-package-staging")), []);
  const staging = resolve(dir, ".skill-package-staging/incomplete"); await mkdir(staging);
  await assert.rejects(resolveSandboxSkillRoots(dir, dir, staging), /workspace|outside/i);
  const stored = await store.put(source);
  const script = resolve(stored.root, "selected/scripts/check.sh");
  await rm(script); await writeFile(script, "tampered");
  await assert.rejects(store.get(stored.id), /integrity/);
  await assert.rejects(resolveSandboxSkillRoots(dir, dir, stored.root), /integrity/);
  await rm(script); await symlink(resolve(stored.root, "selected/SKILL.md"), script);
  await assert.rejects(store.get(stored.id), /Symlink/);
});

test("a snapshot whose manifest was rewritten to match tampered bytes is still refused", async (t) => {
  const dir = await dataDir("skill-manifest-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RunnerSkillPackages(dir);
  const stored = await store.put(bundle());
  const manifestPath = resolve(stored.root, ".skill-bundle.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    skills: Array<{ files: Array<{ hash: string; path: string; size: number }> }>;
  };

  // Rewrite one file and its manifest entry together. The per-file digest now
  // agrees with the bytes, so only recomputing the whole package hash from the
  // same read catches it — which is what keeps a rewritten script off a mount.
  const tampered = Buffer.from("echo tampered\n");
  const script = resolve(stored.root, "selected/scripts/check.sh");
  await rm(script);
  await writeFile(script, tampered);
  const entry = manifest.skills[0]!.files.find((file) => file.path === "scripts/check.sh")!;
  entry.hash = digest(tampered);
  entry.size = tampered.length;
  await rm(manifestPath);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(store.get(stored.id), /integrity/);

  // Dropping a file from the manifest instead does not hide it from the mount.
  manifest.skills[0]!.files = manifest.skills[0]!.files.filter((file) => file.path !== "SKILL.md");
  await rm(manifestPath);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(store.get(stored.id), /Unexpected Skill snapshot file: selected\/SKILL\.md/);
});
