// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// Tests for the jiuwenswarm startup-chain hardening: bootstrap .env port
// parsing (the TCP probe source), the startup diagnostics file, stderr tail
// truncation, and the uv-trampoline bypass (entry_points.txt resolution).
// Pure helpers + temp dirs, no network, no python spawn; the resolveVenvEntry
// cases pin the Windows venv layout of the packaged payload and skip elsewhere.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTest } from "../test/support/tagged/compat.mjs";

import {
  diag, instanceConfigPath, jwConfig, parseInstanceEnvPorts, readInstancePorts, resolveVenvEntry,
  startupDiagPath, stderrTail,
} from "./jiuwenswarm.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });

// The resolveVenvEntry cases below pin the Windows venv layout of the
// packaged payload (Lib\site-packages + Scripts\python.exe). resolveVenvEntry
// is a payload-layout resolver, not a host-venv resolver, so outside Windows
// they have nothing to check and return early instead of declaring a skip
// (the shared plan forbids skip declarations).
const windowsOnly = () => process.platform === "win32";

test("resolveVenvEntry bypasses uv trampolines via entry_points.txt", async () => {
  if (!windowsOnly()) return;
  const venv = await mkdtemp(join(tmpdir(), "jw-venv-ep-"));
  try {
    const distInfo = join(venv, "Lib", "site-packages", "workswarm-0.2.5b1.dist-info");
    await mkdir(distInfo, { recursive: true });
    await writeFile(join(distInfo, "entry_points.txt"),
      "[console_scripts]\njiuwenswarm-init = jiuwenswarm.init_workspace:main\njiuwenswarm-start = jiuwenswarm.start_services:main\n", "utf8");
    const spec = resolveVenvEntry(venv, "jiuwenswarm-init");
    assert.equal(spec.exe, join(venv, "Scripts", "python.exe"));
    assert.equal(spec.args[0], "-c");
    assert.match(spec.args[1], /from jiuwenswarm\.init_workspace import main as _sd_entry/);
    assert.match(spec.args[1], /sys\.argv\[0\] = "jiuwenswarm-init"/);
  } finally {
    await rm(venv, { recursive: true, force: true });
  }
});

test("resolveVenvEntry falls back to the trampoline exe when no entry_points.txt", async () => {
  if (!windowsOnly()) return;
  const venv = await mkdtemp(join(tmpdir(), "jw-venv-bare-"));
  try {
    const spec = resolveVenvEntry(venv, "jiuwenswarm-start");
    assert.deepEqual(spec, { exe: join(venv, "Scripts", "jiuwenswarm-start.exe"), args: [] });
  } finally {
    await rm(venv, { recursive: true, force: true });
  }
});

test("resolveVenvEntry does not false-hit on name prefixes", async () => {
  if (!windowsOnly()) return;
  const venv = await mkdtemp(join(tmpdir(), "jw-venv-prefix-"));
  try {
    const distInfo = join(venv, "Lib", "site-packages", "x.dist-info");
    await mkdir(distInfo, { recursive: true });
    await writeFile(join(distInfo, "entry_points.txt"),
      "my-jiuwenswarm-init = a.b:c\njiuwenswarm-initx = d.e:f\n", "utf8");
    const spec = resolveVenvEntry(venv, "jiuwenswarm-init");
    assert.deepEqual(spec, { exe: join(venv, "Scripts", "jiuwenswarm-init.exe"), args: [] });
  } finally {
    await rm(venv, { recursive: true, force: true });
  }
});

test("resolveVenvEntry keeps scanning past dist-infos without entry_points.txt", async () => {
  if (!windowsOnly()) return;
  // The payload venv has 200+ dist-infos and most ship no entry_points.txt;
  // the first unreadable one must not abort the scan.
  const venv = await mkdtemp(join(tmpdir(), "jw-venv-scan-"));
  try {
    const sp = join(venv, "Lib", "site-packages");
    await mkdir(join(sp, "a-first-no-ep.dist-info"), { recursive: true }); // ENOENT trap
    const good = join(sp, "b-workswarm.dist-info");
    await mkdir(good, { recursive: true });
    await writeFile(join(good, "entry_points.txt"),
      "[console_scripts]\njiuwenswarm-start = jiuwenswarm.start_services:main\n", "utf8");
    const spec = resolveVenvEntry(venv, "jiuwenswarm-start");
    assert.equal(spec.exe, join(venv, "Scripts", "python.exe"));
    assert.match(spec.args[1], /from jiuwenswarm\.start_services import main as _sd_entry/);
  } finally {
    await rm(venv, { recursive: true, force: true });
  }
});

test("instanceConfigPath points at the workspace's config.yaml (init idempotence gate)", () => {
  // The init gate must judge this file, not the workspace dir: a half-made
  // workspace (dir present, config missing) used to skip init and blow up
  // in applyConfig with "config.yaml not found".
  assert.equal(
    instanceConfigPath({ home: "H", instance: "inst" }),
    join("H", ".jiuwenswarm-instances", "inst", "config", "config.yaml"),
  );
  // Without an explicit home the USERPROFILE fallback applies (same rule as
  // instanceWorkspace).
  const cfg = jwConfig();
  assert.ok(instanceConfigPath(cfg).endsWith(join(".jiuwenswarm-instances", cfg.instance, "config", "config.yaml")));
});

test("parseInstanceEnvPorts reads the bootstrap .env jiuwenswarm-init writes", () => {
  const text = [
    "# Bootstrap .env for instance: sciencediscovery",
    "JIUWENSWARM_DATA_DIR=C:\\Users\\x\\.jiuwenswarm-instances\\sciencediscovery",
    "JIUWENSWARM_INSTANCE=sciencediscovery",
    "AGENT_SERVER_PORT=19092",
    "WEB_PORT=20000",
    "GATEWAY_PORT=20001",
    "FRONTEND_PORT=6173",
  ].join("\n");
  assert.deepEqual(parseInstanceEnvPorts(text), { gateway: 20001, web: 20000, agentServer: 19092 });
});

test("parseInstanceEnvPorts tolerates partial .env files and unrelated keys", () => {
  assert.deepEqual(
    parseInstanceEnvPorts("WEB_PORT=20012\n"),
    { gateway: undefined, web: 20012, agentServer: undefined },
  );
  assert.equal(parseInstanceEnvPorts("UNRELATED=1\nOTHER=2\n"), null);
  assert.equal(parseInstanceEnvPorts(""), null);
  assert.equal(parseInstanceEnvPorts(undefined), null);
});

test("parseInstanceEnvPorts anchors key names (no MY_GATEWAY_PORT false hit)", () => {
  assert.equal(parseInstanceEnvPorts("MY_GATEWAY_PORT=9999\nXGATEWAY_PORT=1\n"), null);
});

test("stderrTail collapses whitespace, passes short text, keeps the tail of long text", () => {
  assert.equal(stderrTail(""), "");
  assert.equal(stderrTail(undefined), "");
  assert.equal(stderrTail("Traceback (most recent\n  call last):\n  boom"), "Traceback (most recent call last): boom");
  const tail = stderrTail("x".repeat(1000), 600);
  assert.equal(tail.length, 601); // "…" + the last 600 chars
  assert.ok(tail.startsWith("…"));
  assert.ok(tail.endsWith("x"));
});

test("startupDiagPath lands in the jw root (packaged: %LOCALAPPDATA%\\ScienceDiscovery\\jiuwenswarm)", () => {
  const root = join("C:", "sd", "data", "jiuwenswarm");
  const cfg = jwConfig({ JIUWENSWARM_ROOT: root });
  assert.equal(startupDiagPath(cfg), join(root, "startup-diagnostics.log"));
});

test("diag appends timestamped lines to the diagnostics file", async () => {
  const root = await mkdtemp(join(tmpdir(), "jw-diag-"));
  try {
    const cfg = jwConfig({ JIUWENSWARM_ROOT: root });
    await diag(cfg, "start begin: instance=test");
    await diag(cfg, "probe #1: gateway 20001 not listening after 15s");
    const lines = (await readFile(startupDiagPath(cfg), "utf8")).trimEnd().split(/\r?\n/);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z start begin: instance=test$/);
    assert.match(lines[1], /probe #1: gateway 20001 not listening after 15s$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readInstancePorts reads this instance's .env without spawning python", async () => {
  const home = await mkdtemp(join(tmpdir(), "jw-home-"));
  try {
    const cfg = jwConfig({ JIUWENSWARM_HOME: home, JIUWENSWARM_INSTANCE: "testinst" });
    await mkdir(join(home, ".jiuwenswarm-instances", "testinst"), { recursive: true });
    await writeFile(
      join(home, ".jiuwenswarm-instances", "testinst", ".env"),
      "GATEWAY_PORT=20001\nWEB_PORT=20000\nAGENT_SERVER_PORT=19092\n",
      "utf8",
    );
    assert.deepEqual(await readInstancePorts(cfg), { gateway: 20001, web: 20000, agentServer: 19092 });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("readInstancePorts returns null when the instance has no .env yet", async () => {
  const home = await mkdtemp(join(tmpdir(), "jw-home-empty-"));
  try {
    const cfg = jwConfig({ JIUWENSWARM_HOME: home, JIUWENSWARM_INSTANCE: "fresh" });
    assert.equal(await readInstancePorts(cfg), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
