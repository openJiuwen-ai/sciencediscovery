// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Tests for the cross-platform stack helpers and the JiuwenSwarm
// config applicator. Pure helpers + temp dirs, no network; every case
// asserts its platform branches and runs on any host.

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTest } from "../test/support/tagged/compat.mjs";

import {
  absoluteFromRepository, findHostPython, isWindows, loadDotEnv,
  portAvailability, probeTcp, venvEntry, venvPython, waitHealthy,
} from "./lib/stack-platform.mjs";
import { applyConfig } from "./jiuwenswarm.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });

test("absoluteFromRepository recognises posix, drive-letter and UNC absolutes", () => {
  const root = isWindows ? "C:\\repo" : "/repo";
  assert.equal(absoluteFromRepository(root, "/abs/path"), "/abs/path");
  assert.equal(absoluteFromRepository(root, "C:\\data"), "C:\\data");
  assert.equal(absoluteFromRepository(root, "c:/data"), "c:/data");
  assert.equal(absoluteFromRepository(root, "\\\\host\\share"), "\\\\host\\share");
  const relative = absoluteFromRepository(root, ".sciencediscovery-data");
  assert.ok(relative.startsWith(root));
  assert.ok(relative.includes(".sciencediscovery-data"));
});

test("venvPython picks Scripts/python.exe on Windows, bin/python elsewhere", () => {
  const got = venvPython(join("x", "envs", "gateway"));
  if (isWindows) assert.match(got, /Scripts[\\/]python\.exe$/);
  else assert.match(got, /bin\/python$/);
  const entry = venvEntry(join("x", ".venv"), "jiuwenswarm-start");
  if (isWindows) assert.match(entry, /Scripts[\\/]jiuwenswarm-start\.exe$/);
  else assert.match(entry, /bin\/jiuwenswarm-start$/);
});

test("findHostPython honours SCIENCE_AGENT_PYTHON_PATH override", () => {
  const env = { SCIENCE_AGENT_PYTHON_PATH: process.execPath, PATH: "" };
  assert.equal(findHostPython(env), process.execPath);
});

test("serviceCommand resolves bare commands through the merged environment PATH", async () => {
  // Regression: spawnService looked the command up in the caller's *overrides*
  // alone (no PATH key there at all) and threw "command not found on PATH: uv"
  // even when uv was installed.
  const { serviceCommand } = await import("./lib/stack-platform.mjs");
  const dir = await mkdtemp(join(tmpdir(), "sd-stack-path-"));
  try {
    const name = isWindows ? "sd-probe-cmd.exe" : "sd-probe-cmd";
    await writeFile(join(dir, name), "probe");
    const saved = process.env.PATH;
    process.env.PATH = dir + (isWindows ? ";" : ":") + (saved ?? "");
    try {
      assert.equal(serviceCommand("sd-probe-cmd", { SD_PROBE_OVERRIDE: "1" }), join(dir, name));
      // An override PATH wins over the process one.
      assert.equal(serviceCommand("sd-probe-cmd", { PATH: dir }), join(dir, name));
    } finally {
      process.env.PATH = saved;
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("loadDotEnv parses KEY=VALUE, quotes, export prefix; existing env wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sd-dotenv-"));
  try {
    const file = join(dir, ".env");
    await writeFile(file, [
      "# comment",
      "FOO=bar",
      'QUOTED="hello world"',
      "export EXPORTED=1",
      "EMPTY=",
      "not a line",
      "",
    ].join("\n"), "utf8");
    const env = { FOO: "preexisting" };
    const loaded = await loadDotEnv(file, env);
    assert.equal(env.FOO, "preexisting");
    assert.equal(env.QUOTED, "hello world");
    assert.equal(env.EXPORTED, "1");
    assert.equal(env.EMPTY, "");
    assert.equal(loaded, 3);
    assert.equal(await loadDotEnv(join(dir, "missing"), env), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("portAvailability reports EADDRINUSE for an occupied port and ok for a free one", async () => {
  const blocker = createServer();
  await new Promise(resolveListen => blocker.listen(0, "127.0.0.1", resolveListen));
  try {
    const port = blocker.address().port;
    assert.deepEqual(await portAvailability("127.0.0.1", port), { ok: false, code: "EADDRINUSE" });
    assert.equal(await probeTcp("127.0.0.1", port), true);
  } finally {
    await new Promise(resolveClose => blocker.close(resolveClose));
  }
});

test("waitHealthy polls until the endpoint answers", async () => {
  const server = createHttpServer((request, response) => {
    response.writeHead(request.url === "/health" ? 200 : 404).end("{}");
  });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const port = server.address().port;
    assert.equal(await waitHealthy("unit", `http://127.0.0.1:${port}/health`, { timeoutSeconds: 2 }), true);
    assert.equal(await waitHealthy("unit", `http://127.0.0.1:${port}/nope`, { timeoutSeconds: 1 }), false);
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
  }
});

async function makeInstance() {
  const home = await mkdtemp(join(tmpdir(), "sd-jw-"));
  const configDir = join(home, ".jiuwenswarm-instances", "unit", "config");
  await mkdir(configDir, { recursive: true });
  return { home, configDir, cfg: { home, instance: "unit" } };
}

test("applyConfig forces progressive_tool_enabled off and seeds free-search env", async () => {
  const { home, configDir, cfg } = await makeInstance();
  try {
    await writeFile(join(configDir, "config.yaml"), "progressive_tool_enabled: true\ncontext_engine_config:\n", "utf8");
    await applyConfig(cfg, { contextWindowTokens: "" });
    const text = await readFile(join(configDir, "config.yaml"), "utf8");
    assert.match(text, /^progressive_tool_enabled: false$/m);
    const envText = await readFile(join(configDir, ".env"), "utf8");
    assert.match(envText, /^FREE_SEARCH_DDG_ENABLED="true"$/m);
    assert.match(envText, /^FREE_SEARCH_BING_ENABLED="true"$/m);
    // Idempotent: a second run changes nothing.
    await applyConfig(cfg, { contextWindowTokens: "" });
    assert.equal(await readFile(join(configDir, ".env"), "utf8"), envText);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("applyConfig prepends the key when missing and manages context_window_tokens", async () => {
  const { home, configDir, cfg } = await makeInstance();
  try {
    await writeFile(join(configDir, "config.yaml"), "context:\n  context_engine_config:\n", "utf8");
    await applyConfig(cfg, { contextWindowTokens: "123456" });
    let text = await readFile(join(configDir, "config.yaml"), "utf8");
    assert.ok(text.startsWith("progressive_tool_enabled: false\n"));
    assert.match(text, /^    context_window_tokens: 123456 {2}# set by scripts\/jiuwenswarm\.sh$/m);
    // Reset: removing the override removes the managed line, not the section.
    await applyConfig(cfg, { contextWindowTokens: "" });
    text = await readFile(join(configDir, "config.yaml"), "utf8");
    assert.doesNotMatch(text, /context_window_tokens/);
    assert.match(text, /^  context_engine_config:$/m);
    await assert.rejects(applyConfig(cfg, { contextWindowTokens: "abc" }), /positive integer/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("applyConfig reports a missing instance config", async () => {
  const home = await mkdtemp(join(tmpdir(), "sd-jw-"));
  try {
    await assert.rejects(
      applyConfig({ home, instance: "absent" }, { contextWindowTokens: "" }),
      /not found; run setup first/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
