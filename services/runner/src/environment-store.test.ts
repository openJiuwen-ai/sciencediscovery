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
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  EnvironmentStore,
  installManagedMicromamba,
  managedMicromambaRelease,
  type ProvisionerExecutor,
} from "./environment-store.js";

async function fixture(
  context: { after: (callback: () => Promise<void>) => void },
  options: { beforeCommand?: (arguments_: string[]) => Promise<void> | void } = {},
) {
  const root = resolve(process.cwd(), ".tmp", `environment-store-${process.pid}-${Date.now()}-${Math.random()}`);
  const provisionerPath = resolve(root, "micromamba-test");
  await mkdir(root, { recursive: true });
  await writeFile(provisionerPath, "#!/bin/sh\nexit 0\n");
  await chmod(provisionerPath, 0o755);
  context.after(() => rm(root, { force: true, recursive: true }));

  const installed = new Map<string, string[]>();
  const commands: string[][] = [];
  const executions: Array<{ arguments: string[]; environment?: NodeJS.ProcessEnv; executable: string }> = [];
  const executor: ProvisionerExecutor = async (actualProvisionerPath, arguments_, _jobId, environment) => {
    executions.push({ arguments: arguments_, environment, executable: actualProvisionerPath });
    if (actualProvisionerPath !== provisionerPath) {
      assert.match(actualProvisionerPath, /[\\/]bin[\\/](?:python|R)$/);
      return "";
    }
    commands.push(arguments_);
    await options.beforeCommand?.(arguments_);
    const command = arguments_[1];
    const prefixIndex = arguments_.indexOf("--prefix");
    const prefix = prefixIndex >= 0 ? arguments_[prefixIndex + 1]! : "";
    if (command === "create") {
      const cloneIndex = arguments_.indexOf("--clone");
      const packages = cloneIndex >= 0
        ? [...(installed.get(arguments_[cloneIndex + 1]!) ?? [])]
        : arguments_.filter((argument) => /^[a-zA-Z0-9_.+-]+=/.test(argument));
      installed.set(prefix, packages);
      await mkdir(resolve(prefix, "bin"), { recursive: true });
      await writeFile(resolve(prefix, "bin", "python"), "test python");
      await writeFile(resolve(prefix, "bin", "R"), "test R");
      await chmod(resolve(prefix, "bin", "python"), 0o755);
      await chmod(resolve(prefix, "bin", "R"), 0o755);
      return "";
    }
    if (command === "install") {
      const packages = arguments_.filter((argument) => /^[a-zA-Z0-9_.+-]+=/.test(argument));
      if (packages.some((item) => item.startsWith("conflict="))) throw new Error("dependency conflict");
      installed.set(prefix, [...(installed.get(prefix) ?? []), ...packages]);
      return "";
    }
    if (command === "remove") {
      const prefixIndex = arguments_.indexOf("--prefix");
      const requested = new Set(arguments_.slice(prefixIndex + 2).map((item) => item.split(/[<>=!~]/, 1)[0]));
      installed.set(prefix, (installed.get(prefix) ?? []).filter((item) => !requested.has(item.split(/[<>=!~]/, 1)[0])));
      return "";
    }
    if (command === "list") {
      return JSON.stringify((installed.get(prefix) ?? []).map((specification) => {
        const [name, version = "unknown"] = specification.split("=");
        return { build_string: "test_0", name, version };
      }));
    }
    throw new Error(`Unexpected provisioner command: ${command}`);
  };

  const store = new EnvironmentStore({
    allowedChannels: ["conda-forge"],
    enabled: true,
    provisionerPath,
    root: resolve(root, "envs"),
    runnerVersion: "test-runner",
  }, executor);
  return { commands, executions, provisionerPath, root, store };
}

test("scientific environment lifecycle advances immutable revisions only after success", async (context) => {
  const { store } = await fixture(context);
  await store.initialize();
  assert.equal(store.setup.state, "not-configured");
  assert.equal(store.capability.available, false);
  await store.setupManagedEnvironments();
  assert.deepEqual(store.capability.languages, ["python"]);
  assert.equal(store.capability.startersReady, true);
  assert.deepEqual(store.list().map((environment) => environment.id), ["starter-python"]);

  const task = await store.createTask("single-cell", "python");
  assert.equal(task.kind, "task");
  const initialRevisionId = task.currentRevisionId;
  const installed = await store.install(task.id, ["scanpy=1.10"], ["conda-forge"]);
  assert.notEqual(installed.id, initialRevisionId);
  assert.equal(store.list().find((environment) => environment.id === task.id)?.currentRevisionId, installed.id);
  assert.ok(installed.packages.some((item) => item.startsWith("scanpy=1.10")));
  const uninstalled = await store.uninstall(task.id, ["scanpy"]);
  assert.notEqual(uninstalled.id, installed.id);
  assert.equal(uninstalled.packages.some((item) => item.startsWith("scanpy=")), false);
  const snapshot = await store.snapshotBytes(installed.id);
  assert.equal(createHash("sha256").update(snapshot).digest("hex"), installed.snapshot.hash);

  await assert.rejects(store.install(task.id, ["conflict=1"], ["conda-forge"]), /dependency conflict/);
  assert.equal(store.list().find((environment) => environment.id === task.id)?.currentRevisionId, uninstalled.id);
  await assert.rejects(store.install("starter-python", ["scanpy=1.10"]), /read-only/);
  await assert.rejects(store.uninstall("starter-python", ["numpy"]), /read-only/);
  await assert.rejects(store.deleteTask("starter-python"), /cannot be deleted/);

  await Promise.all([
    store.install(task.id, ["anndata=0.10"]),
    store.install(task.id, ["leidenalg=0.10"]),
  ]);
  const currentRevisionId = store.list().find((environment) => environment.id === task.id)!.currentRevisionId;
  const currentRevision = store.listRevisions().find((revision) => revision.id === currentRevisionId)!;
  assert.ok(currentRevision.packages.some((item) => item.startsWith("anndata=0.10")));
  assert.ok(currentRevision.packages.some((item) => item.startsWith("leidenalg=0.10")));

  await store.deleteTask(task.id);
  assert.equal(store.list().some((environment) => environment.id === task.id), false);
});

test("trusted provisioning uses fixed channels while agent runtimes remain a separate no-network path", async (context) => {
  const { commands, store } = await fixture(context);
  await store.initialize();
  await store.setupManagedEnvironments();
  const task = await store.createTask("online-task", "python");
  await store.install(task.id, ["scanpy=1.10"]);
  assert.ok(commands.every((command) => command[0] === "--no-rc"));
  assert.ok(commands.every((command) => !command.includes("--offline")));
  const install = commands.find((command) => command[1] === "install");
  assert.ok(install?.includes("--override-channels"));
  assert.deepEqual(install?.slice(install.indexOf("--channel"), install.indexOf("--channel") + 2), ["--channel", "conda-forge"]);
});

test("task environments support structured pip sources, CRAN, and Bioconductor workflows without root", async (context) => {
  const { executions, store } = await fixture(context);
  const previousPythonEnvironment = {
    PYTHONHOME: process.env.PYTHONHOME,
    PYTHONPATH: process.env.PYTHONPATH,
    PYTHONUSERBASE: process.env.PYTHONUSERBASE,
  };
  process.env.PYTHONHOME = "/host/python-home";
  process.env.PYTHONPATH = "/host/python-path";
  process.env.PYTHONUSERBASE = "/host/python-user-base";
  context.after(async () => {
    for (const [name, value] of Object.entries(previousPythonEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  await store.initialize();
  await store.setupManagedEnvironments();
  const python = await store.createTask("pip-task", "python");
  const pipRevision = await store.install(
    python.id,
    ["torch", "torchvision"],
    undefined,
    "pip",
    undefined,
    "https://download.pytorch.org/whl/cpu",
  );
  assert.ok(pipRevision.packages.includes("pip:torch"));
  assert.ok(pipRevision.packages.includes("pip:torchvision"));
  assert.deepEqual(pipRevision.channels, ["https://download.pytorch.org/whl/cpu"]);
  const pip = executions.find((execution) => /[\\/]bin[\\/]python$/.test(execution.executable));
  assert.equal(pip?.environment?.PYTHONHOME, undefined);
  assert.equal(pip?.environment?.PYTHONPATH, undefined);
  assert.equal(pip?.environment?.PYTHONUSERBASE, undefined);
  assert.deepEqual(pip?.arguments.slice(0, 7), ["-I", "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--index-url"]);
  assert.deepEqual(pip?.arguments.slice(7), [
    "https://download.pytorch.org/whl/cpu",
    "torch",
    "torchvision",
  ]);
  await assert.rejects(
    store.install(python.id, ["numpy"], undefined, "pip", undefined, "http://mirror.example/simple"),
    /must use HTTPS/,
  );
  await assert.rejects(
    store.install(python.id, ["--extra-index-url=https://attacker.example"], undefined, "pip"),
    /Invalid package specification/,
  );

  const r = await store.createTask("r-packages", "r");
  assert.equal(store.list().some((environment) => environment.id === "starter-r"), true);
  const cranRevision = await store.install(r.id, ["survival"], undefined, "cran");
  assert.ok(cranRevision.packages.includes("cran:survival"));
  const biocRevision = await store.install(r.id, ["DESeq2"], undefined, "bioconductor");
  assert.ok(biocRevision.packages.includes("bioconductor:DESeq2"));
  const rExecutions = executions.filter((execution) => /[\\/]bin[\\/]R$/.test(execution.executable));
  assert.match(rExecutions[0]?.arguments.at(-1) ?? "", /cloud\.r-project\.org/);
  assert.match(rExecutions[1]?.arguments.at(-1) ?? "", /BiocManager::install/);
  assert.equal(executions.some((execution) => execution.executable === "/usr/bin/apt" || execution.arguments.includes("sudo")), false);
});

test("built-in conda mirror channels are governed without changing the upstream default", async (context) => {
  const { commands, store } = await fixture(context);
  await store.initialize();
  await store.setupManagedEnvironments();
  const task = await store.createTask("conda-mirror", "python");
  await store.install(task.id, ["numpy"], [
    "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge",
  ]);
  const install = commands.findLast((command) => command[1] === "install");
  assert.ok(install);
  assert.deepEqual(
    install.slice(install.indexOf("--channel"), install.indexOf("--channel") + 2),
    ["--channel", "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge"],
  );
  await assert.rejects(
    store.install(task.id, ["numpy"], ["https://attacker.example/conda"]),
    /Package channels are not allowed/,
  );
});

test("pip installs PyPI specs and retains local wheels by content hash in the revision snapshot", async (context) => {
  const { executions, provisionerPath, root, store } = await fixture(context);
  await store.initialize();
  await store.setupManagedEnvironments();
  const environment = await store.createTask("wheel-audit", "python");
  const initialRevisionId = environment.currentRevisionId;

  const pypiRevision = await store.install(environment.id, ["mindspore==2.7.0"], undefined, "pip");
  assert.notEqual(pypiRevision.id, initialRevisionId);
  assert.ok(pypiRevision.packages.includes("pip:mindspore==2.7.0"));

  const workspaceRoot = resolve(root, "workspace");
  const relativeWheel = "wheels/example_pkg-1.2.3-py3-none-any.whl";
  const wheelBytes = Buffer.from("local wheel bytes for audit");
  await mkdir(resolve(workspaceRoot, "wheels"), { recursive: true });
  await writeFile(resolve(workspaceRoot, relativeWheel), wheelBytes);
  const wheelRevision = await store.install(environment.id, [relativeWheel], undefined, "pip", workspaceRoot);
  assert.notEqual(wheelRevision.id, pypiRevision.id);
  const wheel = wheelRevision.localWheels?.[0];
  assert.ok(wheel);
  assert.deepEqual(wheel, {
    content: { hash: createHash("sha256").update(wheelBytes).digest("hex"), size: wheelBytes.length },
    distribution: "example-pkg",
    filename: "example_pkg-1.2.3-py3-none-any.whl",
    manager: "pip",
    sourcePath: relativeWheel,
    version: "1.2.3",
  });
  assert.ok(wheelRevision.packages.some((item) => item.includes(`\"path\":\"${relativeWheel}\"`)
    && item.includes(`\"sha256\":\"${wheel.content.hash}\"`)));

  const persistedWheel = resolve(root, "envs", "wheels", wheel.content.hash, wheel.filename);
  await rm(workspaceRoot, { force: true, recursive: true });
  assert.deepEqual(await readFile(persistedWheel), wheelBytes);
  const snapshot = JSON.parse((await store.snapshotBytes(wheelRevision.id)).toString("utf8")) as {
    localWheels: typeof wheelRevision.localWheels;
    packages: string[];
  };
  assert.deepEqual(snapshot.localWheels, wheelRevision.localWheels);
  assert.ok(snapshot.packages.some((item) => item.includes(wheel.content.hash)));
  const laterRevision = await store.install(environment.id, ["audit-helper=1.0"]);
  assert.deepEqual(laterRevision.localWheels, wheelRevision.localWheels);

  const reloaded = new EnvironmentStore({
    allowedChannels: ["conda-forge"],
    enabled: true,
    provisionerPath,
    root: resolve(root, "envs"),
    runnerVersion: "test-runner",
  });
  await reloaded.initialize();
  assert.deepEqual(reloaded.getRevision(laterRevision.id)?.localWheels, wheelRevision.localWheels);

  const pipExecutions = executions.filter((execution) => /[\\/]bin[\\/]python$/.test(execution.executable));
  assert.ok(pipExecutions.some((execution) => execution.arguments.includes("mindspore==2.7.0")));
  assert.ok(pipExecutions.some((execution) => execution.arguments.includes(persistedWheel)));
  assert.equal(pipExecutions.some((execution) => execution.arguments.includes(resolve(workspaceRoot, relativeWheel))), false);
});

test("local wheel installs reject missing workspace context, traversal, external symlinks, and URLs", async (context) => {
  const { root, store } = await fixture(context);
  await store.initialize();
  await store.setupManagedEnvironments();
  const environment = await store.createTask("wheel-security", "python");
  const workspaceRoot = resolve(root, "workspace");
  const outsideWheel = resolve(root, "outside_pkg-1.0-py3-none-any.whl");
  await mkdir(resolve(workspaceRoot, "wheels"), { recursive: true });
  await writeFile(outsideWheel, "outside wheel");
  await writeFile(resolve(workspaceRoot, "wheels", "not-a-wheel.txt"), "not a wheel");
  await symlink(outsideWheel, resolve(workspaceRoot, "wheels", "linked_pkg-1.0-py3-none-any.whl"));
  await mkdir(resolve(workspaceRoot, "wheels", "directory_pkg-1.0-py3-none-any.whl"));

  await assert.rejects(
    store.install(environment.id, ["wheels/missing_pkg-1.0-py3-none-any.whl"], undefined, "pip"),
    /require a Session workspace/,
  );
  await assert.rejects(
    store.install(environment.id, ["../outside_pkg-1.0-py3-none-any.whl"], undefined, "pip", workspaceRoot),
    /escapes the Session workspace/,
  );
  await assert.rejects(
    store.install(environment.id, [outsideWheel], undefined, "pip", workspaceRoot),
    /workspace-relative paths/,
  );
  await assert.rejects(
    store.install(environment.id, ["wheels/missing_pkg-1.0-py3-none-any.whl"], undefined, "pip", workspaceRoot),
    /ENOENT/,
  );
  await assert.rejects(
    store.install(environment.id, ["wheels/linked_pkg-1.0-py3-none-any.whl"], undefined, "pip", workspaceRoot),
    /escapes the Session workspace/,
  );
  await assert.rejects(
    store.install(environment.id, ["wheels/directory_pkg-1.0-py3-none-any.whl"], undefined, "pip", workspaceRoot),
    /regular file/,
  );
  await assert.rejects(
    store.install(environment.id, ["wheels/not-a-wheel.txt"], undefined, "pip", workspaceRoot),
    /Invalid package specification/,
  );
  await assert.rejects(
    store.install(environment.id, ["https://packages.example.test/pkg.whl"], undefined, "pip", workspaceRoot),
    /Remote pip URLs are not allowed/,
  );
  await assert.rejects(
    store.install("starter-python", ["mindspore==2.7.0"], undefined, "pip", workspaceRoot),
    /read-only/,
  );
});

test("scientific environments remain unavailable until managed setup succeeds", async (context) => {
  const { root } = await fixture(context);
  const missingProvisioner = new EnvironmentStore({
    allowedChannels: ["conda-forge"],
    enabled: true,
    root: resolve(root, "missing-provisioner"),
    runnerVersion: "test",
  }, undefined, async () => { throw new Error("fixed provisioner source unavailable"); });
  await missingProvisioner.initialize();
  assert.equal(missingProvisioner.setup.state, "not-configured");
  await assert.rejects(missingProvisioner.setupManagedEnvironments(), /fixed provisioner source unavailable/);
  assert.equal(missingProvisioner.setup.state, "failed");
  await assert.rejects(async () => missingProvisioner.list(), /fixed provisioner source unavailable/);

  const disabled = new EnvironmentStore({
    allowedChannels: ["conda-forge"],
    enabled: false,
    root: resolve(root, "disabled"),
    runnerVersion: "test",
  });
  await disabled.initialize();
  assert.equal(disabled.capability.available, false);
  await assert.rejects(async () => disabled.list(), /disabled/);
});

test("background setup exposes progress, serializes callers, and retries after failure", async (context) => {
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolveGate) => { releaseCreate = resolveGate; });
  let failNextCreate = false;
  const { store } = await fixture(context, {
    beforeCommand: async (arguments_) => {
      if (arguments_[1] !== "create") return;
      await createGate;
      if (failNextCreate) {
        failNextCreate = false;
        throw new Error("temporary bootstrap failure");
      }
    },
  });
  await store.initialize();

  const started = store.startManagedEnvironmentSetup();
  assert.equal(started.state, "installing");
  assert.equal(started.startedAt !== null, true);
  const firstWaiter = store.setupManagedEnvironments();
  const secondWaiter = store.setupManagedEnvironments();
  releaseCreate();
  const [first, second] = await Promise.all([firstWaiter, secondWaiter]);
  assert.equal(first.state, "ready");
  assert.equal(second.state, "ready");
  assert.equal(store.list().some((environment) => environment.id === "starter-r"), false);

  const retryFixture = await fixture(context, {
    beforeCommand: (arguments_) => {
      if (arguments_[1] === "create" && failNextCreate) {
        failNextCreate = false;
        throw new Error("temporary bootstrap failure");
      }
    },
  });
  await retryFixture.store.initialize();
  failNextCreate = true;
  await assert.rejects(retryFixture.store.setupManagedEnvironments(), /temporary bootstrap failure/);
  assert.equal(retryFixture.store.setup.state, "failed");
  assert.equal(retryFixture.store.setup.error, "temporary bootstrap failure");
  assert.equal((await retryFixture.store.setupManagedEnvironments()).state, "ready");
});

test("existing R base and named environments remain available after catalog reload", async (context) => {
  const { provisionerPath, root, store } = await fixture(context);
  await store.initialize();
  await store.setupManagedEnvironments();
  const task = await store.createTask("existing-r-task", "r");

  const reloaded = new EnvironmentStore({
    allowedChannels: ["conda-forge"],
    enabled: true,
    provisionerPath,
    root: resolve(root, "envs"),
    runnerVersion: "test-runner",
  });
  await reloaded.initialize();

  assert.equal(reloaded.setup.state, "ready");
  assert.deepEqual(reloaded.capability.languages, ["python", "r"]);
  assert.deepEqual(
    reloaded.list().map((environment) => environment.id),
    ["starter-python", "starter-r", task.id],
  );
});

test("managed provisioner installation rejects bytes that do not match the pinned release", async (context) => {
  const { root } = await fixture(context);
  const destination = resolve(root, "managed", "micromamba");
  await assert.rejects(
    installManagedMicromamba(destination, async () => new Response("not micromamba", { status: 200 }), "x64", "linux"),
    /SHA-256 verification/,
  );
});

test("managed provisioner selects pinned Linux x64 and arm64 releases", async (context) => {
  const { root } = await fixture(context);
  const x64 = managedMicromambaRelease("x64", "linux");
  assert.equal(x64.filename, "micromamba-linux-64");
  assert.equal(x64.dockerArch, "amd64");
  assert.equal(x64.packageArch, "x86_64");
  assert.equal(x64.url, "https://github.com/mamba-org/micromamba-releases/releases/download/2.8.1-0/micromamba-linux-64");
  assert.equal(x64.sha256, "9689782d863c05a1bf5d2d371ba527104e7a4eb4310c1637d8653b751aed9c82");

  const arm64 = managedMicromambaRelease("arm64", "linux");
  assert.equal(arm64.filename, "micromamba-linux-aarch64");
  assert.equal(arm64.dockerArch, "arm64");
  assert.equal(arm64.packageArch, "aarch64");
  assert.equal(arm64.url, "https://github.com/mamba-org/micromamba-releases/releases/download/2.8.1-0/micromamba-linux-aarch64");
  assert.equal(arm64.sha256, "e5ba23b5945aa49dfd11022e592a510d2686a8feee810e00140b73c9fdf0ba2a");

  assert.throws(() => managedMicromambaRelease("riscv64", "linux"), /unavailable for architecture riscv64/);
  assert.throws(() => managedMicromambaRelease("x64", "darwin"), /requires Linux, not darwin/);

  const requestedUrls: string[] = [];
  await assert.rejects(
    installManagedMicromamba(
      resolve(root, "managed-arm64", "micromamba"),
      async (input) => {
        requestedUrls.push(input.toString());
        return new Response("not micromamba", { status: 200 });
      },
      "arm64",
      "linux",
    ),
    /SHA-256 verification/,
  );
  assert.deepEqual(requestedUrls, [arm64.url]);
});
