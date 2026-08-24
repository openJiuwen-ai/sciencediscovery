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
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { after, before, beforeEach, describe, test } from "node:test";

import {
  ensureGatewayEnvironment,
  ensureUv,
  findWheelUrl,
  resolveBootstrapSettings,
  runBootstrap,
  withBootstrapLock,
  type BootstrapIo,
  type BootstrapSettings,
  type RunResult,
} from "./bootstrap.js";
import type { PayloadBootstrap, PayloadManifest } from "./payload-manifest.js";

const execFileAsync = promisify(execFile);

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const WHEEL_BYTES = Buffer.from("not really a zip, the fake extractor never reads it");
const WHEEL_SHA256 = createHash("sha256").update(WHEEL_BYTES).digest("hex");

function bootstrapFixture(): PayloadBootstrap {
  return {
    gatewayWheelPath: "bootstrap/wheels/sciencediscovery_gateway-0.0.0-py3-none-any.whl",
    requirementsPath: "bootstrap/requirements-gateway.txt",
    uv: {
      project: "uv",
      version: "0.9.26",
      wheelFilename: "uv-0.9.26-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
      wheelSha256: WHEEL_SHA256,
    },
  };
}

function fakeResponse(options: {
  body?: Buffer | string;
  status?: number;
  url?: string;
  stream?: boolean;
}): Response {
  const bytes = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body ?? "");
  const status = options.status ?? 200;
  return {
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    body: options.stream ? Readable.toWeb(Readable.from(bytes)) : undefined,
    ok: status >= 200 && status < 300,
    status,
    text: async () => bytes.toString("utf8"),
    url: options.url ?? "",
  } as unknown as Response;
}

interface IoOptions {
  fetch?: (url: string) => Promise<Response> | Response;
  findExecutable?: (command: string) => Promise<string | undefined>;
  run?: (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
  ) => Promise<RunResult>;
}

function fakeIo(options: IoOptions = {}): BootstrapIo & { logs: string[] } {
  const logs: string[] = [];
  return {
    fetch: (async (input: string | URL | Request) => {
      if (!options.fetch) throw new Error(`Unexpected fetch: ${String(input)}`);
      return await options.fetch(String(input));
    }) as typeof fetch,
    findExecutable: options.findExecutable ?? (async () => undefined),
    log: (message) => logs.push(message),
    logs,
    run: async (command, args, runOptions) => {
      if (!options.run) throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      return await options.run(command, args, runOptions);
    },
  };
}

function settingsFixture(dataDir: string, overrides: Partial<BootstrapSettings> = {}): BootstrapSettings {
  return {
    dataDir,
    pypiIndex: "https://mirror.example/pypi/simple",
    uvInstallIndex: "https://mirror.example/pypi/simple",
    ...overrides,
  };
}

describe("bootstrap configuration", () => {
  test("defaults to the Huawei Cloud PyPI mirror", () => {
    const settings = resolveBootstrapSettings({}, "/data");
    assert.equal(settings.pypiIndex, "https://mirrors.huaweicloud.com/repository/pypi/simple");
    assert.equal(settings.uvInstallIndex, settings.pypiIndex);
    assert.equal(settings.uvPathOverride, undefined);
  });

  test("environment variables override every default", () => {
    const settings = resolveBootstrapSettings(
      {
        SCIENCE_AGENT_PYPI_INDEX: "https://pypi.org/simple",
        SCIENCE_AGENT_UV_INSTALL_INDEX: "https://other.example/simple",
        SCIENCE_AGENT_UV_PATH: "/usr/local/bin/uv",
      },
      "/data",
    );
    assert.equal(settings.pypiIndex, "https://pypi.org/simple");
    assert.equal(settings.uvInstallIndex, "https://other.example/simple");
    assert.equal(settings.uvPathOverride, "/usr/local/bin/uv");
  });
});

describe("wheel URL discovery", () => {
  test("resolves a relative simple-index href against the page URL", async () => {
    const filename = "uv-0.9.26-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl";
    const io = fakeIo({
      fetch: (url) => {
        assert.equal(url, "https://mirror.example/pypi/simple/uv/");
        return fakeResponse({
          body: `<a href="../../packages/ab/cd/${filename}#sha256=feed">${filename}</a>`,
          url,
        });
      },
    });
    assert.equal(
      await findWheelUrl(io, "https://mirror.example/pypi/simple", "uv", filename),
      `https://mirror.example/pypi/packages/ab/cd/${filename}`,
    );
  });

  test("reports an index that does not list the pinned wheel", async () => {
    const io = fakeIo({ fetch: (url) => fakeResponse({ body: "<a href=\"other.whl\">other</a>", url }) });
    await assert.rejects(
      findWheelUrl(io, "https://mirror.example/pypi/simple", "uv", "uv-1.whl"),
      /does not list uv-1\.whl/,
    );
  });
});

describe("uv installation", () => {
  let workspace = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "sciencediscovery-bootstrap-uv-"));
  });

  after(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  async function freshDataDir(name: string): Promise<string> {
    const dataDir = join(workspace, name);
    await mkdir(dataDir, { recursive: true });
    return dataDir;
  }

  test("downloads, verifies and extracts the pinned wheel once", async () => {
    const dataDir = await freshDataDir("full-install");
    const bootstrap = bootstrapFixture();
    const settings = settingsFixture(dataDir);
    const fetched: string[] = [];
    const io = fakeIo({
      fetch: (url) => {
        fetched.push(url);
        if (url.endsWith("/uv/")) {
          return fakeResponse({ body: `<a href="/artifacts/${bootstrap.uv.wheelFilename}#sha256=x">l</a>`, url });
        }
        return fakeResponse({ body: WHEEL_BYTES });
      },
      run: async (command, args) => {
        // The bundled interpreter unzips the wheel; emulate its one job.
        assert.equal(command, "/payload/python/bin/python3");
        assert.deepEqual(args.slice(0, 3), ["-m", "zipfile", "-e"]);
        const destination = args[4] as string;
        const scripts = join(destination, "uv-0.9.26.data", "scripts");
        await mkdir(scripts, { recursive: true });
        await writeFile(join(scripts, "uv"), "#!/bin/sh\nexit 0\n");
        return { stderr: "", stdout: "" };
      },
    });

    const binary = await ensureUv(io, settings, bootstrap, "/payload/python/bin/python3");
    assert.equal(binary, join(dataDir, "tools", "uv", "0.9.26", "uv"));
    await access(binary, constants.X_OK);
    assert.deepEqual(fetched, [
      "https://mirror.example/pypi/simple/uv/",
      `https://mirror.example/artifacts/${bootstrap.uv.wheelFilename}`,
    ]);
    assert.deepEqual(await readdir(join(dataDir, ".bootstrap-staging")), []);

    // Second launch: the installed binary short-circuits every download.
    const offline = fakeIo({});
    assert.equal(await ensureUv(offline, settings, bootstrap, "/payload/python/bin/python3"), binary);
  });

  test("rejects a wheel whose checksum does not match the pin and names the overrides", async () => {
    const dataDir = await freshDataDir("bad-checksum");
    const bootstrap = bootstrapFixture();
    const io = fakeIo({
      fetch: (url) => url.endsWith("/uv/")
        ? fakeResponse({ body: `<a href="w/${bootstrap.uv.wheelFilename}">l</a>`, url })
        : fakeResponse({ body: Buffer.from("tampered bytes") }),
    });
    await assert.rejects(
      ensureUv(io, settingsFixture(dataDir), bootstrap, "/payload/python"),
      (error: Error) => {
        assert.match(error.message, /Checksum mismatch/);
        assert.match(error.message, /SCIENCE_AGENT_UV_INSTALL_INDEX/);
        assert.match(error.message, /SCIENCE_AGENT_UV_PATH/);
        return true;
      },
    );
  });

  test("an operator-provided uv is used as-is and must be executable", async () => {
    const dataDir = await freshDataDir("override");
    const bootstrap = bootstrapFixture();
    const io = fakeIo({ findExecutable: async (command) => (command === "/opt/uv" ? "/opt/uv" : undefined) });
    const settings = settingsFixture(dataDir, { uvPathOverride: "/opt/uv" });
    assert.equal(await ensureUv(io, settings, bootstrap, "/payload/python"), "/opt/uv");

    const missing = fakeIo({ findExecutable: async () => undefined });
    await assert.rejects(
      ensureUv(missing, settingsFixture(dataDir, { uvPathOverride: "/opt/gone" }), bootstrap, "/payload/python"),
      /SCIENCE_AGENT_UV_PATH points at \/opt\/gone/,
    );
  });
});

describe("gateway environment provisioning", () => {
  let workspace = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "sciencediscovery-bootstrap-env-"));
  });

  after(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  function manifestFixture(bootstrap: PayloadBootstrap): PayloadManifest {
    return {
      app: {
        apiEntry: "app/services/api/dist/server.js",
            root: "app",
        runnerEntry: "app/services/runner/dist/server.js",
        webDir: "app/apps/web/dist",
      },
      architecture: "x86_64",
      bootstrap,
      formatVersion: 2,
      node: { path: "node/bin/node", version: "v22.19.0" },
      product: "sciencediscovery",
      python: { path: "python/bin/python3", sitePackages: "python/lib/python3.12/site-packages", version: "3.12.13" },
      runtimeArchitecture: "x64",
      version: "0.0.0",
    };
  }

  const gatewaySentinel = join("lib", "site-packages", "sciencediscovery_gateway", "uniprot_mcp.py");

  function simulatedGatewayIo(options: { failInstall?: boolean } = {}): {
    invocations: Array<{
      args: string[];
      command: string;
      options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };
    }>;
    io: BootstrapIo & { logs: string[] };
  } {
    const invocations: Array<{
      args: string[];
      command: string;
      options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };
    }> = [];
    const io = fakeIo({
      run: async (command, args, runOptions) => {
        invocations.push({ args, command, options: runOptions });
        if (command !== "/tools/uv") {
          assert.deepEqual(args.slice(0, 2), ["-I", "-c"]);
          const configured = runOptions?.env?.SCIENCE_AGENT_EXTERNAL_URLS_PATH?.trim();
          const configPath = configured || join(runOptions?.cwd ?? "", "config", "external-urls.json");
          await access(configPath).catch(() => {
            throw new Error(`External URL configuration not found at ${configPath}`);
          });
          await access(join(dirname(dirname(command)), gatewaySentinel));
          return { stderr: "", stdout: "" };
        }
        if (args[0] === "venv") {
          const staging = args[1] as string;
          assert.ok(args.includes("--relocatable"));
          await mkdir(join(staging, "bin"), { recursive: true });
          await writeFile(join(staging, "bin", "python"), "#!/bin/sh\n");
          await chmod(join(staging, "bin", "python"), 0o755);
          return { stderr: "", stdout: "" };
        }
        if (options.failInstall) throw new Error("simulated install failure");
        if (args.includes("--no-deps")) {
          const python = args[args.indexOf("--python") + 1] as string;
          const sentinel = join(dirname(dirname(python)), gatewaySentinel);
          await mkdir(dirname(sentinel), { recursive: true });
          await writeFile(sentinel, "# installed gateway\n");
        }
        return { stderr: "", stdout: "" };
      },
    });
    return { invocations, io };
  }

  async function gatewayFixture(name: string): Promise<{
    appRoot: string;
    bootstrap: PayloadBootstrap;
    dataDir: string;
    payloadRoot: string;
    settings: BootstrapSettings;
  }> {
    const dataDir = join(workspace, name);
    const payloadRoot = join(workspace, `${name}-payload`);
    const appRoot = join(payloadRoot, "app");
    const bootstrap = bootstrapFixture();
    await mkdir(join(payloadRoot, "bootstrap", "wheels"), { recursive: true });
    await mkdir(join(appRoot, "config"), { recursive: true });
    await writeFile(join(appRoot, "config", "external-urls.json"), "{}\n");
    await writeFile(join(payloadRoot, bootstrap.requirementsPath), "fastapi==0.115.0 --hash=sha256:abc\n");
    await writeFile(join(payloadRoot, bootstrap.gatewayWheelPath), "wheel bytes");
    return { appRoot, bootstrap, dataDir, payloadRoot, settings: settingsFixture(dataDir) };
  }

  const gatewayRuntime = (appRoot: string, env: NodeJS.ProcessEnv = {}) => ({ cwd: appRoot, env });

  test("provisions the venv from the hashed requirements and is idempotent", async () => {
    const { appRoot, bootstrap, dataDir, payloadRoot, settings } = await gatewayFixture("provision");
    const environmentDir = join(dataDir, "envs", "gateway");
    const { invocations, io } = simulatedGatewayIo();

    const python = await ensureGatewayEnvironment(
      io, settings, bootstrap, payloadRoot, manifestFixture(bootstrap), "/tools/uv",
      gatewayRuntime(appRoot),
    );
    assert.equal(python, join(environmentDir, "bin", "python"));

    assert.equal(invocations.length, 4);
    assert.equal(invocations[0]?.command, "/tools/uv");
    assert.equal(invocations[0]?.args[0], "venv");
    assert.match(invocations[0]?.args[1] ?? "", /\.bootstrap-staging\/gateway-env\./);
    const requirementsInstall = invocations[1]?.args as string[];
    assert.ok(requirementsInstall.includes("--require-hashes"), "third-party install must enforce hashes");
    assert.deepEqual(
      requirementsInstall.slice(requirementsInstall.indexOf("--index-url"), requirementsInstall.indexOf("--index-url") + 2),
      ["--index-url", settings.pypiIndex],
    );
    const localInstall = invocations[2]?.args as string[];
    assert.ok(localInstall.includes("--no-deps"), "local packages must not pull unpinned dependencies");
    assert.ok(localInstall.includes(join(payloadRoot, bootstrap.gatewayWheelPath)));

    // Unchanged inputs: one local import probe, no uv or network work.
    const healthy = simulatedGatewayIo();
    assert.equal(
      await ensureGatewayEnvironment(
        healthy.io, settings, bootstrap, payloadRoot, manifestFixture(bootstrap), "/tools/uv",
        gatewayRuntime(appRoot),
      ),
      python,
    );
    assert.equal(healthy.invocations.length, 1);
    assert.equal(healthy.invocations[0]?.command, python);
    assert.notEqual(process.cwd(), appRoot, "the launcher test cwd must be unrelated to the extracted app root");
    assert.equal(healthy.invocations[0]?.options?.cwd, appRoot);
    assert.deepEqual(healthy.invocations[0]?.options?.env, {});

    // A changed requirements export invalidates the marker and rebuilds.
    await writeFile(join(payloadRoot, bootstrap.requirementsPath), "fastapi==0.116.0 --hash=sha256:def\n");
    invocations.length = 0;
    await ensureGatewayEnvironment(
      io, settings, bootstrap, payloadRoot, manifestFixture(bootstrap), "/tools/uv",
      gatewayRuntime(appRoot),
    );
    assert.equal(invocations.length, 4);
  });

  test("fails loudly when the planned app root lacks its required external URL config", async () => {
    const { appRoot, bootstrap, dataDir, payloadRoot, settings } = await gatewayFixture("missing-app-config");
    const environmentDir = join(dataDir, "envs", "gateway");
    await ensureGatewayEnvironment(
      simulatedGatewayIo().io,
      settings,
      bootstrap,
      payloadRoot,
      manifestFixture(bootstrap),
      "/tools/uv",
      gatewayRuntime(appRoot),
    );
    await rm(join(appRoot, "config", "external-urls.json"));

    await assert.rejects(
      ensureGatewayEnvironment(
        simulatedGatewayIo().io,
        settings,
        bootstrap,
        payloadRoot,
        manifestFixture(bootstrap),
        "/tools/uv",
        gatewayRuntime(appRoot),
      ),
      /External URL configuration not found.*missing-app-config-payload\/app\/config\/external-urls\.json/,
    );
    await access(join(environmentDir, ".sciencediscovery-bootstrap.json"));
  });

  test("preserves an operator-provided external URL config path in the probe environment", async () => {
    const { appRoot, bootstrap, dataDir, payloadRoot, settings } = await gatewayFixture("configured-app-config");
    const configured = join(dataDir, "operator", "external-urls.json");
    await mkdir(dirname(configured), { recursive: true });
    await writeFile(configured, "{}\n");
    await rm(join(appRoot, "config", "external-urls.json"));
    const simulated = simulatedGatewayIo();

    await ensureGatewayEnvironment(
      simulated.io,
      settings,
      bootstrap,
      payloadRoot,
      manifestFixture(bootstrap),
      "/tools/uv",
      gatewayRuntime(appRoot, { SCIENCE_AGENT_EXTERNAL_URLS_PATH: configured }),
    );
    const probe = simulated.invocations.at(-1);
    assert.equal(probe?.options?.cwd, appRoot);
    assert.equal(probe?.options?.env?.SCIENCE_AGENT_EXTERNAL_URLS_PATH, configured);
  });

  test("rebuilds a marker-matching environment whose gateway package was deleted", async () => {
    const { appRoot, bootstrap, dataDir, payloadRoot, settings } = await gatewayFixture("damaged-package");
    const environmentDir = join(dataDir, "envs", "gateway");
    const installedSentinel = join(environmentDir, gatewaySentinel);
    await ensureGatewayEnvironment(
      simulatedGatewayIo().io,
      settings,
      bootstrap,
      payloadRoot,
      manifestFixture(bootstrap),
      "/tools/uv",
      gatewayRuntime(appRoot),
    );
    await rm(dirname(installedSentinel), { force: true, recursive: true });

    const recovery = simulatedGatewayIo();
    await ensureGatewayEnvironment(
      recovery.io,
      settings,
      bootstrap,
      payloadRoot,
      manifestFixture(bootstrap),
      "/tools/uv",
      gatewayRuntime(appRoot),
    );
    await access(installedSentinel);
    assert.equal(recovery.invocations[0]?.command, join(environmentDir, "bin", "python"));
    assert.ok(recovery.invocations.some(({ command }) => command === "/tools/uv"));
    assert.ok(recovery.io.logs.some((line) => line.includes("integrity check failed")));

    const secondLaunch = simulatedGatewayIo();
    await ensureGatewayEnvironment(
      secondLaunch.io,
      settings,
      bootstrap,
      payloadRoot,
      manifestFixture(bootstrap),
      "/tools/uv",
      gatewayRuntime(appRoot),
    );
    assert.deepEqual(secondLaunch.invocations.map(({ command }) => command), [join(environmentDir, "bin", "python")]);
  });

  test("reuses an environment whose marker still carries the former product name", async () => {
    const { appRoot, bootstrap, dataDir, payloadRoot, settings } = await gatewayFixture("legacy-marker");
    const environmentDir = join(dataDir, "envs", "gateway");
    await ensureGatewayEnvironment(
      simulatedGatewayIo().io,
      settings,
      bootstrap,
      payloadRoot,
      manifestFixture(bootstrap),
      "/tools/uv",
      gatewayRuntime(appRoot),
    );
    await rename(
      join(environmentDir, ".sciencediscovery-bootstrap.json"),
      join(environmentDir, ".science-agent-bootstrap.json"),
    );

    const upgrade = simulatedGatewayIo();
    await ensureGatewayEnvironment(
      upgrade.io,
      settings,
      bootstrap,
      payloadRoot,
      manifestFixture(bootstrap),
      "/tools/uv",
      gatewayRuntime(appRoot),
    );
    // Only the sentinel import probe runs: no uv invocation means no reinstall.
    assert.deepEqual(upgrade.invocations.map(({ command }) => command), [join(environmentDir, "bin", "python")]);
    assert.ok(upgrade.io.logs.some((line) => line.includes(".science-agent-bootstrap.json")));
  });

  test("keeps the previous environment recoverable when a rebuild fails", async () => {
    const { appRoot, bootstrap, dataDir, payloadRoot, settings } = await gatewayFixture("failed-rebuild");
    const environmentDir = join(dataDir, "envs", "gateway");
    const markerPath = join(environmentDir, ".sciencediscovery-bootstrap.json");
    const python = join(environmentDir, "bin", "python");
    await ensureGatewayEnvironment(
      simulatedGatewayIo().io,
      settings,
      bootstrap,
      payloadRoot,
      manifestFixture(bootstrap),
      "/tools/uv",
      gatewayRuntime(appRoot),
    );
    await rm(join(environmentDir, "lib", "site-packages", "sciencediscovery_gateway"), { force: true, recursive: true });
    const oldMarker = await readFile(markerPath, "utf8");
    const oldPython = await readFile(python, "utf8");

    await assert.rejects(
      ensureGatewayEnvironment(
        simulatedGatewayIo({ failInstall: true }).io,
        settings,
        bootstrap,
        payloadRoot,
        manifestFixture(bootstrap),
        "/tools/uv",
        gatewayRuntime(appRoot),
      ),
      /simulated install failure/,
    );
    assert.equal(await readFile(markerPath, "utf8"), oldMarker);
    assert.equal(await readFile(python, "utf8"), oldPython);

    await ensureGatewayEnvironment(
      simulatedGatewayIo().io,
      settings,
      bootstrap,
      payloadRoot,
      manifestFixture(bootstrap),
      "/tools/uv",
      gatewayRuntime(appRoot),
    );
    await access(join(environmentDir, gatewaySentinel));
  });

  test("restores the previous environment after an interrupted directory swap", async () => {
    const { appRoot, bootstrap, dataDir, payloadRoot, settings } = await gatewayFixture("interrupted-swap");
    const environmentDir = join(dataDir, "envs", "gateway");
    await ensureGatewayEnvironment(
      simulatedGatewayIo().io,
      settings,
      bootstrap,
      payloadRoot,
      manifestFixture(bootstrap),
      "/tools/uv",
      gatewayRuntime(appRoot),
    );
    const backup = join(dataDir, ".bootstrap-staging", "gateway-env-backup");
    await rename(environmentDir, backup);

    const recovered = simulatedGatewayIo();
    await ensureGatewayEnvironment(
      recovered.io,
      settings,
      bootstrap,
      payloadRoot,
      manifestFixture(bootstrap),
      "/tools/uv",
      gatewayRuntime(appRoot),
    );
    assert.deepEqual(recovered.invocations.map(({ command }) => command), [join(environmentDir, "bin", "python")]);
    await assert.rejects(stat(backup));
  });
});

describe("bootstrap lock", () => {
  test("serializes concurrent bootstraps and recovers a dead holder's lock", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sciencediscovery-bootstrap-lock-"));
    try {
      const io = fakeIo({});
      const order: string[] = [];
      let release: () => void = () => {};
      const gate = new Promise<void>((resolveGate) => { release = resolveGate; });

      const first = withBootstrapLock(workspace, io, async () => {
        order.push("first-start");
        await gate;
        order.push("first-end");
      });
      // Give the first call time to take the lock before contending.
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
      const second = withBootstrapLock(workspace, io, async () => {
        order.push("second");
      });
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
      release();
      await Promise.all([first, second]);
      assert.deepEqual(order, ["first-start", "first-end", "second"]);

      // A lock left behind by a dead process must not block forever.
      await mkdir(join(workspace, ".bootstrap.lock"));
      await writeFile(join(workspace, ".bootstrap.lock", "pid"), "999999999");
      await withBootstrapLock(workspace, io, async () => order.push("takeover"));
      assert.ok(order.includes("takeover"));
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });
});

describe("runBootstrap", () => {
  test("requires a manifest with a bootstrap section", async () => {
    await assert.rejects(
      runBootstrap({
        dataDir: "/data",
        env: {},
        gatewayRuntime: { cwd: "/payload/app", env: {} },
        log: () => {},
        manifest: { formatVersion: 1 } as PayloadManifest,
        payloadRoot: "/payload",
      }),
      /requires a payload manifest with a bootstrap section/,
    );
  });
});
