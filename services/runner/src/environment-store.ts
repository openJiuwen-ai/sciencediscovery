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

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type {
  Environment,
  EnvironmentLocalWheel,
  EnvironmentPackageManager,
  EnvironmentRevision,
  ScientificEnvironmentSetup,
  ScientificEnvsCapability,
  ScientificLanguage,
} from "@sciencediscovery/schema";
import {
  ENVIRONMENT_PACKAGE_SOURCE_PRESETS,
  externalUrl,
  normalizePipIndexUrl,
} from "@sciencediscovery/schema";

import micromambaManifest from "./micromamba-releases.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const CATALOG_VERSION = 1;
const MANAGED_MICROMAMBA_VERSION = micromambaManifest.version;
const MANAGED_MICROMAMBA_BASE_URL = `${micromambaManifest.baseUrl}/${MANAGED_MICROMAMBA_VERSION}`;
const MANAGED_MICROMAMBA_RELEASES = micromambaManifest.releases;
const MAX_PROVISIONER_BYTES = 64 * 1024 * 1024;
const BUILT_IN_CONDA_CHANNELS = new Set<string>(
  ENVIRONMENT_PACKAGE_SOURCE_PRESETS.flatMap((preset) => [...preset.condaChannels]),
);
const STARTER_PACKAGES: Record<ScientificLanguage, string[]> = {
  python: ["python=3.12", "numpy=2.0", "pandas=2.2", "scipy=1.14", "matplotlib=3.9"],
  r: ["r-base=4.4", "r-tidyverse=2.0", "r-data.table=1.16"],
};

interface EnvironmentCatalog {
  environments: Environment[];
  revisions: EnvironmentRevision[];
  version: typeof CATALOG_VERSION;
}

interface ProvisionedPackage {
  build_string?: string;
  name?: string;
  version?: string;
}

export type ProvisionerExecutor = (
  provisionerPath: string,
  arguments_: string[],
  jobId: string,
  environment?: NodeJS.ProcessEnv,
) => Promise<string>;
export type ProvisionerInstaller = (destination: string) => Promise<void>;

export interface EnvironmentStoreConfig {
  allowedChannels: string[];
  enabled: boolean;
  packageCacheDir?: string;
  platform?: string;
  provisionerPath?: string;
  root: string;
  runnerVersion: string;
}

export interface EnvironmentRuntime {
  environment: Environment;
  interpreterPath: string;
  prefixPath: string;
  revision: EnvironmentRevision;
}

type SupportedMicromambaArchitecture = keyof typeof MANAGED_MICROMAMBA_RELEASES;

export function managedMicromambaRelease(
  architecture: string = process.arch,
  platform: string = process.platform,
) {
  if (platform !== "linux") {
    throw new Error(`Managed micromamba installation requires Linux, not ${platform}`);
  }
  const release = MANAGED_MICROMAMBA_RELEASES[architecture as SupportedMicromambaArchitecture];
  if (!release) {
    throw new Error(`Managed micromamba installation is unavailable for architecture ${architecture}`);
  }
  return {
    ...release,
    url: `${MANAGED_MICROMAMBA_BASE_URL}/${release.filename}`,
    version: MANAGED_MICROMAMBA_VERSION,
  };
}

export async function installManagedMicromamba(
  destination: string,
  fetcher: typeof fetch = fetch,
  architecture: string = process.arch,
  platform: string = process.platform,
): Promise<void> {
  const release = managedMicromambaRelease(architecture, platform);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.download`;
  try {
    const response = await fetcher(release.url, {
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Managed provisioner download failed (${response.status})`);
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_PROVISIONER_BYTES) throw new Error("Managed provisioner download exceeds size limit");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_PROVISIONER_BYTES) {
      throw new Error("Managed provisioner download has an invalid size");
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== release.sha256) {
      throw new Error("Managed provisioner download failed SHA-256 verification");
    }
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o700 });
    await chmod(temporary, 0o700);
    await rename(temporary, destination);
  } finally {
    clearTimeout(timeout);
    await rm(temporary, { force: true });
  }
}

function safeName(value: string, label: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 80 || !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/.test(normalized)) {
    throw new Error(`${label} must be 1-80 safe display characters`);
  }
  return normalized;
}

function safePackage(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || !/^[a-zA-Z0-9_.:+-]+(?:[<>=!~][a-zA-Z0-9_.:+*!<>=~-]+)?$/.test(normalized)) {
    throw new Error(`Invalid package specification: ${value}`);
  }
  return normalized;
}

function isLocalWheelPath(value: string): boolean {
  return value.toLowerCase().endsWith(".whl");
}

function wheelDistribution(filename: string): Pick<EnvironmentLocalWheel, "distribution" | "version"> {
  const fields = filename.slice(0, -4).split("-");
  if (fields.length < 5 || !fields[0] || !fields[1]) return {};
  return { distribution: fields[0].replaceAll("_", "-"), version: fields[1] };
}

function wheelPackageRecord(wheel: EnvironmentLocalWheel): string {
  return `pip:wheel:${JSON.stringify({
    distribution: wheel.distribution,
    path: wheel.sourcePath,
    sha256: wheel.content.hash,
    version: wheel.version,
  })}`;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function mergeLocalWheels(...groups: Array<readonly EnvironmentLocalWheel[] | undefined>): EnvironmentLocalWheel[] {
  const wheels = new Map<string, EnvironmentLocalWheel>();
  for (const wheel of groups.flatMap((group) => group ?? [])) {
    wheels.set(`${wheel.content.hash}:${wheel.sourcePath}`, wheel);
  }
  return [...wheels.values()].toSorted((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].toSorted();
}

function emptyCatalog(): EnvironmentCatalog {
  return { environments: [], revisions: [], version: CATALOG_VERSION };
}

export class EnvironmentStore {
  private catalog = emptyCatalog();
  private initialized = false;
  private readonly catalogPath: string;
  private readonly revisionsRoot: string;
  private readonly snapshotsRoot: string;
  private readonly wheelsRoot: string;
  private readonly provisioner: ProvisionerExecutor;
  private readonly provisionerInstaller: ProvisionerInstaller;
  private provisionerPath: string;
  private setupState: ScientificEnvironmentSetup["state"];
  private setupPhase: ScientificEnvironmentSetup["phase"];
  private setupMessage: string;
  private setupStartedAt: string | null = null;
  private setupCompletedAt: string | null = null;
  private setupUpdatedAt = new Date().toISOString();
  private setupPromise?: Promise<ScientificEnvironmentSetup>;
  private mutationTail: Promise<void> = Promise.resolve();
  private lastSetupError?: string;

  constructor(
    private readonly config: EnvironmentStoreConfig,
    provisioner?: ProvisionerExecutor,
    provisionerInstaller: ProvisionerInstaller = installManagedMicromamba,
  ) {
    this.catalogPath = resolve(config.root, "catalog.json");
    this.revisionsRoot = resolve(config.root, "revisions");
    this.snapshotsRoot = resolve(config.root, "snapshots");
    this.wheelsRoot = resolve(config.root, "wheels");
    this.provisionerPath = config.provisionerPath ?? resolve(config.root, "bin", "micromamba");
    this.setupState = config.enabled ? "not-configured" : "disabled";
    this.setupPhase = config.enabled ? "pending" : "disabled";
    this.setupMessage = config.enabled
      ? "Python base environment is waiting to be installed"
      : "Scientific environments are disabled by configuration";
    this.provisionerInstaller = provisionerInstaller;
    this.provisioner = provisioner ?? (async (provisionerPath, arguments_, _jobId, environment) => {
      const result = await execFileAsync(provisionerPath, arguments_, {
        encoding: "utf8",
        env: {
          ...(environment ?? process.env),
          MAMBA_ROOT_PREFIX: resolve(config.root, "provisioner"),
          ...(config.packageCacheDir ? { CONDA_PKGS_DIRS: config.packageCacheDir } : {}),
        },
        maxBuffer: 8 * 1024 * 1024,
      });
      return result.stdout;
    });
  }

  get capability(): ScientificEnvsCapability {
    if (!this.config.enabled) {
      return {
        available: false,
        enabled: false,
        languages: [],
        provisioner: null,
        startersReady: false,
        unavailableReason: "Scientific environments are disabled by configuration",
      };
    }
    const pythonBaseReady = this.catalog.environments.some((environment) => environment.id === "starter-python");
    const languages = (["python", "r"] as const)
      .filter((language) => this.catalog.environments.some((environment) => environment.id === `starter-${language}`));
    return {
      available: this.initialized && this.setupState === "ready" && pythonBaseReady,
      enabled: true,
      languages,
      provisioner: this.setupState === "ready" ? basename(this.provisionerPath) : null,
      startersReady: pythonBaseReady,
      ...(!this.initialized || this.setupState !== "ready" || !pythonBaseReady
        ? { unavailableReason: this.lastSetupError ?? "Scientific environments are not configured; install them in System Settings" }
        : {}),
    };
  }

  get setup(): ScientificEnvironmentSetup {
    return {
      allowedChannels: [...this.config.allowedChannels],
      completedAt: this.setupCompletedAt,
      error: this.lastSetupError ?? null,
      ...(this.lastSetupError ? { lastError: this.lastSetupError } : {}),
      managedProvisioner: !this.config.provisionerPath,
      message: this.setupMessage,
      networkPolicy: this.config.packageCacheDir ? "offline-cache" : "allowed-channels",
      phase: this.setupPhase,
      provisioner: this.setupState === "ready" ? basename(this.provisionerPath) : null,
      provisionerVersion: !this.config.provisionerPath && this.setupState === "ready"
        ? managedMicromambaRelease().version
        : null,
      startedAt: this.setupStartedAt,
      starterPackages: structuredClone(STARTER_PACKAGES),
      state: this.setupState,
      updatedAt: this.setupUpdatedAt,
    };
  }

  async initialize(): Promise<void> {
    await mkdir(this.config.root, { recursive: true });
    await mkdir(this.revisionsRoot, { recursive: true });
    await mkdir(this.snapshotsRoot, { recursive: true });
    await mkdir(this.wheelsRoot, { recursive: true });
    if (!this.config.enabled) return void (this.initialized = true);
    await this.loadCatalog();
    if (this.catalog.environments.some((environment) => environment.id === "starter-python")) {
      try {
        await this.validateProvisioner();
        await this.validateStarter("python");
        this.updateSetup("ready", "complete", "Python base environment is ready", { completed: true });
      } catch (error) {
        this.failSetup(error);
      }
    }
    this.initialized = true;
  }

  startManagedEnvironmentSetup(): ScientificEnvironmentSetup {
    if (!this.config.enabled) return this.setup;
    if (this.setupPromise || this.setupState === "ready") return this.setup;
    if (!this.config.allowedChannels.length) {
      this.failSetup(new Error("Scientific environments require at least one allowed package channel"));
      return this.setup;
    }
    this.lastSetupError = undefined;
    this.setupStartedAt = new Date().toISOString();
    this.setupCompletedAt = null;
    this.updateSetup("installing", "checking", "Checking managed environment prerequisites");
    const operation = this.runManagedEnvironmentSetup().finally(() => {
      if (this.setupPromise === operation) this.setupPromise = undefined;
    });
    this.setupPromise = operation;
    // Startup bootstrap is intentionally detached; callers observe failure through GET setup.
    void operation.catch(() => undefined);
    return this.setup;
  }

  async setupManagedEnvironments(): Promise<ScientificEnvironmentSetup> {
    if (!this.config.enabled) throw new Error("Scientific environments are disabled by configuration");
    this.startManagedEnvironmentSetup();
    if (this.setupState === "failed" && !this.setupPromise) {
      throw new Error(this.lastSetupError ?? "Scientific environment setup failed");
    }
    return this.setupPromise ? await this.setupPromise : this.setup;
  }

  private async runManagedEnvironmentSetup(): Promise<ScientificEnvironmentSetup> {
    try {
      if (this.config.packageCacheDir) await access(this.config.packageCacheDir);
      if (this.config.provisionerPath) {
        this.updateSetup("installing", "checking", "Checking configured micromamba provisioner");
        await this.validateProvisioner();
      } else {
        this.updateSetup("installing", "downloading-provisioner", "Downloading and verifying managed micromamba");
        await this.ensureManagedProvisioner();
      }
      if (!this.catalog.environments.some((environment) => environment.id === "starter-python")) {
        this.updateSetup("installing", "creating-python-base", "Creating the managed Python base environment");
        await this.bootstrapStarter("python");
      }
      this.updateSetup("installing", "verifying-python-base", "Verifying the managed Python base environment");
      await this.validateStarter("python");
      this.initialized = true;
      this.updateSetup("ready", "complete", "Python base environment is ready", { completed: true });
      return this.setup;
    } catch (error) {
      this.initialized = true;
      this.failSetup(error);
      throw error;
    }
  }

  list(): Environment[] {
    this.assertAvailable();
    return this.catalog.environments.map((environment) => ({ ...environment }));
  }

  listRevisions(): EnvironmentRevision[] {
    this.assertAvailable();
    return this.catalog.revisions.map((revision) => ({ ...revision }));
  }

  getRevision(id: string): EnvironmentRevision | undefined {
    const revision = this.catalog.revisions.find((candidate) => candidate.id === id);
    return revision ? { ...revision } : undefined;
  }

  async snapshotBytes(revisionId: string): Promise<Buffer> {
    const revision = this.requiredRevision(revisionId);
    const content = await readFile(resolve(this.snapshotsRoot, `${revision.id}.json`));
    if (createHash("sha256").update(content).digest("hex") !== revision.snapshot.hash) {
      throw new Error(`Environment revision snapshot is corrupt: ${revisionId}`);
    }
    return content;
  }

  resolveRuntime(revisionId: string | undefined, language: ScientificLanguage): EnvironmentRuntime {
    this.assertAvailable();
    return this.resolveRuntimeUnchecked(revisionId, language);
  }

  private resolveRuntimeUnchecked(revisionId: string | undefined, language: ScientificLanguage): EnvironmentRuntime {
    const revision = revisionId
      ? this.requiredRevision(revisionId)
      : this.requiredRevision(this.requiredEnvironment(`starter-${language}`).currentRevisionId);
    if (revision.language !== language) {
      throw new Error(`Environment revision ${revision.id} is ${revision.language}, not ${language}`);
    }
    const environment = this.requiredEnvironment(revision.environmentId);
    const prefixPath = this.revisionPath(environment.id, revision.id);
    return {
      environment: { ...environment },
      interpreterPath: resolve(prefixPath, "bin", language === "python" ? "python" : "R"),
      prefixPath,
      revision: { ...revision },
    };
  }

  async createTask(name: string, language: ScientificLanguage, baseEnvironmentId?: string): Promise<Environment> {
    return await this.enqueueMutation(() => this.createTaskUnlocked(name, language, baseEnvironmentId));
  }

  private async createTaskUnlocked(name: string, language: ScientificLanguage, baseEnvironmentId?: string): Promise<Environment> {
    this.assertAvailable();
    const normalizedName = safeName(name, "Environment name");
    if (this.catalog.environments.some((environment) => environment.name.toLowerCase() === normalizedName.toLowerCase())) {
      throw new Error(`Environment name already exists: ${normalizedName}`);
    }
    const defaultBaseId = `starter-${language}`;
    if (!baseEnvironmentId && language === "r"
      && !this.catalog.environments.some((environment) => environment.id === defaultBaseId)) {
      await this.bootstrapStarter("r");
    }
    const base = this.requiredEnvironment(baseEnvironmentId || defaultBaseId);
    if (base.language !== language) throw new Error("Base environment language does not match the requested language");
    const id = `task-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const revisionId = `rev-${randomUUID()}`;
    const prefix = this.revisionPath(id, revisionId);
    const previousCatalog = structuredClone(this.catalog);
    await mkdir(resolve(prefix, ".."), { recursive: true });
    try {
      await this.runProvisioner([
        "create", "--yes", ...this.offlineArguments(), "--clone", this.revisionPath(base.id, base.currentRevisionId), "--prefix", prefix,
      ], `create-${id}`);
      const baseRevision = this.currentRevision(base.id);
      const revision = await this.recordRevision(
        id,
        revisionId,
        language,
        prefix,
        baseRevision.channels,
        [],
        baseRevision.localWheels,
      );
      const environment: Environment = {
        createdAt,
        currentRevisionId: revision.id,
        id,
        kind: "task",
        language,
        name: normalizedName,
        updatedAt: createdAt,
      };
      this.catalog.environments.push(environment);
      await this.saveCatalog();
      return { ...environment };
    } catch (error) {
      this.catalog = previousCatalog;
      await rm(resolve(this.revisionsRoot, id), { force: true, recursive: true });
      throw error;
    }
  }

  async deleteTask(id: string): Promise<void> {
    await this.enqueueMutation(() => this.deleteTaskUnlocked(id));
  }

  private async deleteTaskUnlocked(id: string): Promise<void> {
    this.assertAvailable();
    const environment = this.requiredEnvironment(id);
    if (environment.kind === "starter") throw new Error("Starter environments cannot be deleted");
    const previousCatalog = structuredClone(this.catalog);
    this.catalog.environments = this.catalog.environments.filter((candidate) => candidate.id !== id);
    this.catalog.revisions = this.catalog.revisions.filter((revision) => revision.environmentId !== id);
    try {
      await this.saveCatalog();
      await rm(resolve(this.revisionsRoot, id), { force: true, recursive: true });
    } catch (error) {
      this.catalog = previousCatalog;
      throw error;
    }
  }

  async install(
    id: string,
    packages: string[],
    requestedChannels?: string[],
    manager: EnvironmentPackageManager = "conda",
    workspaceRoot?: string,
    indexUrl?: string,
  ): Promise<EnvironmentRevision> {
    return await this.enqueueMutation(
      () => this.installUnlocked(id, packages, requestedChannels, manager, workspaceRoot, indexUrl),
    );
  }

  private async installUnlocked(
    id: string,
    packages: string[],
    requestedChannels?: string[],
    manager: EnvironmentPackageManager = "conda",
    workspaceRoot?: string,
    indexUrl?: string,
  ): Promise<EnvironmentRevision> {
    this.assertAvailable();
    const environment = this.requiredEnvironment(id);
    if (environment.kind === "starter") throw new Error("Starter environments are read-only; create a task environment first");
    if (!["bioconductor", "conda", "cran", "pip"].includes(manager)) {
      throw new Error(`Unsupported environment package manager: ${String(manager)}`);
    }
    if (manager === "pip" && environment.language !== "python") throw new Error("pip installs require a Python environment");
    if (manager === "pip" && requestedChannels?.length) {
      throw new Error("channels can only be used with manager=conda");
    }
    if (indexUrl !== undefined && manager !== "pip") throw new Error("indexUrl can only be used with manager=pip");
    const normalizedIndexUrl = manager === "pip" && indexUrl !== undefined
      ? normalizePipIndexUrl(indexUrl)
      : externalUrl("package_indexes.pypi_simple");
    if ((manager === "cran" || manager === "bioconductor") && environment.language !== "r") {
      throw new Error(`${manager} installs require an R environment`);
    }
    if (this.config.packageCacheDir && (manager === "cran" || manager === "bioconductor")) {
      throw new Error(`${manager} installs are unavailable in offline-cache mode; use conda packages from the seeded cache`);
    }
    const normalizedInputs = uniqueSorted(packages.map((value) => value.trim()));
    if (!normalizedInputs.length || normalizedInputs.some((value) => !value)) {
      throw new Error("At least one package is required");
    }
    const localWheels: EnvironmentLocalWheel[] = [];
    const normalizedPackages: string[] = [];
    for (const value of normalizedInputs) {
      if (manager === "pip" && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        throw new Error("Remote pip URLs are not allowed; use a PyPI package specification or workspace-relative .whl path");
      }
      if (manager === "pip" && isLocalWheelPath(value)) {
        if (!workspaceRoot) throw new Error("Local wheel paths require a Session workspace");
        localWheels.push(await this.persistLocalWheel(workspaceRoot, value));
      } else {
        normalizedPackages.push(safePackage(value));
      }
    }
    const channels = uniqueSorted(requestedChannels?.length ? requestedChannels : this.config.allowedChannels);
    const disallowed = channels.filter(
      (channel) => !this.config.allowedChannels.includes(channel) && !BUILT_IN_CONDA_CHANNELS.has(channel),
    );
    if (disallowed.length) throw new Error(`Package channels are not allowed: ${disallowed.join(", ")}`);
    const previousRevision = this.currentRevision(id);
    const previousCatalog = structuredClone(this.catalog);
    const revisionId = `rev-${randomUUID()}`;
    const prefix = this.revisionPath(id, revisionId);
    await mkdir(resolve(prefix, ".."), { recursive: true });
    try {
      await this.runProvisioner([
        "create", "--yes", ...this.offlineArguments(), "--clone", this.revisionPath(id, previousRevision.id), "--prefix", prefix,
      ], `clone-${revisionId}`);
      let revisionChannels = channels;
      if (manager === "conda") {
        await this.runProvisioner([
          "install", "--yes", ...this.offlineArguments(), "--strict-channel-priority", "--override-channels", "--prefix", prefix,
          ...channels.flatMap((channel) => ["--channel", channel]),
          ...normalizedPackages,
        ], `install-${revisionId}`);
      } else if (manager === "pip") {
        const pipArguments = ["-I", "-m", "pip", "install", "--disable-pip-version-check", "--no-input"];
        if (this.config.packageCacheDir) {
          pipArguments.push("--no-index", "--find-links", this.config.packageCacheDir);
        } else {
          pipArguments.push("--index-url", normalizedIndexUrl);
        }
        const wheelPaths = localWheels.map((wheel) => resolve(this.wheelsRoot, wheel.content.hash, wheel.filename));
        await this.runManagedCommand(
          resolve(prefix, "bin", "python"),
          [...pipArguments, ...normalizedPackages, ...wheelPaths],
          `pip-${revisionId}`,
        );
        revisionChannels = [this.config.packageCacheDir ? "offline-cache:pip" : normalizedIndexUrl];
      } else {
        const packageVector = `c(${normalizedPackages.map((value) => JSON.stringify(value)).join(",")})`;
        const cranRepository = externalUrl("package_indexes.cran");
        const expression = manager === "cran"
          ? `install.packages(${packageVector}, repos=${JSON.stringify(cranRepository)}, Ncpus=1)`
          : `if (!requireNamespace("BiocManager", quietly=TRUE)) install.packages("BiocManager", repos=${JSON.stringify(cranRepository)}); BiocManager::install(${packageVector}, ask=FALSE, update=FALSE)`;
        await this.runManagedCommand(resolve(prefix, "bin", "R"), ["--vanilla", "--slave", "-e", expression], `${manager}-${revisionId}`);
        revisionChannels = [manager === "cran" ? cranRepository : externalUrl("package_indexes.bioconductor")];
      }
      const revisionLocalWheels = mergeLocalWheels(previousRevision.localWheels, localWheels);
      const revision = await this.recordRevision(
        id,
        revisionId,
        environment.language,
        prefix,
        revisionChannels,
        normalizedPackages.map((value) => `${manager}:${value}`),
        revisionLocalWheels,
      );
      environment.currentRevisionId = revision.id;
      environment.updatedAt = new Date().toISOString();
      await this.saveCatalog();
      return { ...revision };
    } catch (error) {
      this.catalog = previousCatalog;
      await rm(prefix, { force: true, recursive: true });
      throw error;
    }
  }

  async uninstall(id: string, packages: string[]): Promise<EnvironmentRevision> {
    return await this.enqueueMutation(() => this.uninstallUnlocked(id, packages));
  }

  private async uninstallUnlocked(id: string, packages: string[]): Promise<EnvironmentRevision> {
    this.assertAvailable();
    const environment = this.requiredEnvironment(id);
    if (environment.kind === "starter") throw new Error("Starter environments are read-only; create a task environment first");
    const normalizedPackages = uniqueSorted(packages.map(safePackage));
    if (!normalizedPackages.length) throw new Error("At least one package is required");
    const previousRevision = this.currentRevision(id);
    const previousCatalog = structuredClone(this.catalog);
    const revisionId = `rev-${randomUUID()}`;
    const prefix = this.revisionPath(id, revisionId);
    await mkdir(resolve(prefix, ".."), { recursive: true });
    try {
      await this.runProvisioner([
        "create", "--yes", ...this.offlineArguments(), "--clone", this.revisionPath(id, previousRevision.id), "--prefix", prefix,
      ], `clone-${revisionId}`);
      await this.runProvisioner([
        "remove", "--yes", ...this.offlineArguments(), "--prefix", prefix, ...normalizedPackages,
      ], `uninstall-${revisionId}`);
      const revision = await this.recordRevision(
        id,
        revisionId,
        environment.language,
        prefix,
        previousRevision.channels,
        [],
        previousRevision.localWheels,
      );
      environment.currentRevisionId = revision.id;
      environment.updatedAt = new Date().toISOString();
      await this.saveCatalog();
      return { ...revision };
    } catch (error) {
      this.catalog = previousCatalog;
      await rm(prefix, { force: true, recursive: true });
      throw error;
    }
  }

  private assertAvailable(): void {
    if (!this.config.enabled || !this.initialized || !this.capability.available) {
      throw new Error(this.capability.unavailableReason ?? "Scientific environments are unavailable");
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async bootstrapStarter(language: ScientificLanguage): Promise<void> {
    const id = `starter-${language}`;
    const revisionId = `rev-${randomUUID()}`;
    const prefix = this.revisionPath(id, revisionId);
    const previousCatalog = structuredClone(this.catalog);
    await mkdir(resolve(prefix, ".."), { recursive: true });
    try {
      await this.runProvisioner([
        "create", "--yes", ...this.offlineArguments(), "--strict-channel-priority", "--override-channels", "--prefix", prefix,
        ...this.config.allowedChannels.flatMap((channel) => ["--channel", channel]),
        ...STARTER_PACKAGES[language],
      ], `bootstrap-${language}`);
      const revision = await this.recordRevision(id, revisionId, language, prefix, this.config.allowedChannels);
      const createdAt = new Date().toISOString();
      this.catalog.environments.push({
        createdAt,
        currentRevisionId: revision.id,
        id,
        kind: "starter",
        language,
        name: language === "python" ? "Starter Python" : "Starter R",
        updatedAt: createdAt,
      });
      await this.saveCatalog();
    } catch (error) {
      this.catalog = previousCatalog;
      await rm(resolve(this.revisionsRoot, id), { force: true, recursive: true });
      throw error;
    }
  }

  private async persistLocalWheel(workspaceRoot: string, sourcePath: string): Promise<EnvironmentLocalWheel> {
    const normalizedPath = sourcePath.trim();
    if (!normalizedPath || normalizedPath.length > 512 || isAbsolute(normalizedPath)) {
      throw new Error("Local wheel paths must be non-empty workspace-relative paths of at most 512 characters");
    }
    if (!isLocalWheelPath(normalizedPath)) throw new Error("Local package paths must end in .whl");

    const resolvedWorkspace = await realpath(workspaceRoot);
    const requestedSource = resolve(resolvedWorkspace, normalizedPath);
    if (requestedSource === resolvedWorkspace || !requestedSource.startsWith(`${resolvedWorkspace}${sep}`)) {
      throw new Error(`Local wheel path escapes the Session workspace: ${normalizedPath}`);
    }
    const resolvedSource = await realpath(requestedSource);
    if (resolvedSource === resolvedWorkspace || !resolvedSource.startsWith(`${resolvedWorkspace}${sep}`)) {
      throw new Error(`Local wheel path escapes the Session workspace: ${normalizedPath}`);
    }
    const sourceMetadata = await stat(resolvedSource);
    if (!sourceMetadata.isFile()) throw new Error(`Local wheel must be a regular file: ${normalizedPath}`);

    const sourceHash = await fileSha256(resolvedSource);
    const incoming = resolve(this.wheelsRoot, `.incoming-${randomUUID()}.whl`);
    try {
      await copyFile(resolvedSource, incoming, constants.COPYFILE_EXCL);
      const [copiedHash, copiedMetadata] = await Promise.all([fileSha256(incoming), stat(incoming)]);
      if (copiedHash !== sourceHash) throw new Error(`Local wheel changed while it was copied: ${normalizedPath}`);
      const filename = basename(normalizedPath);
      const storedDirectory = resolve(this.wheelsRoot, copiedHash);
      const storedPath = resolve(storedDirectory, filename);
      await mkdir(storedDirectory, { recursive: true });
      try {
        await access(storedPath, constants.F_OK);
        const [existingHash, existingMetadata] = await Promise.all([fileSha256(storedPath), stat(storedPath)]);
        if (existingHash !== copiedHash || existingMetadata.size !== copiedMetadata.size) {
          throw new Error(`Stored local wheel failed integrity verification: ${normalizedPath}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await rename(incoming, storedPath);
      }
      return {
        content: { hash: copiedHash, size: copiedMetadata.size },
        filename,
        manager: "pip",
        sourcePath: normalizedPath,
        ...wheelDistribution(filename),
      };
    } finally {
      await rm(incoming, { force: true });
    }
  }

  private currentRevision(environmentId: string): EnvironmentRevision {
    return this.requiredRevision(this.requiredEnvironment(environmentId).currentRevisionId);
  }

  private async loadCatalog(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.catalogPath, "utf8")) as EnvironmentCatalog;
      if (parsed.version !== CATALOG_VERSION || !Array.isArray(parsed.environments) || !Array.isArray(parsed.revisions)) {
        throw new Error("Scientific environment catalog has an unsupported format");
      }
      this.catalog = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.catalog = emptyCatalog();
    }
  }

  private async recordRevision(
    environmentId: string,
    revisionId: string,
    language: ScientificLanguage,
    prefix: string,
    channels: string[],
    additionalPackages: string[] = [],
    localWheels: EnvironmentLocalWheel[] = [],
  ): Promise<EnvironmentRevision> {
    const listOutput = await this.runProvisioner(["list", "--json", "--prefix", prefix], `snapshot-${revisionId}`);
    const listed = JSON.parse(listOutput || "[]") as ProvisionedPackage[];
    if (!Array.isArray(listed)) throw new Error("Provisioner package list must be a JSON array");
    const packages = uniqueSorted([...listed.flatMap((item) => item.name && item.version
      ? [`${item.name}=${item.version}${item.build_string ? `=${item.build_string}` : ""}`]
      : []), ...additionalPackages, ...localWheels.map(wheelPackageRecord)]);
    const languagePackage = packages.find((item) => item.startsWith(language === "python" ? "python=" : "r-base="));
    const languageVersion = languagePackage?.split("=")[1] ?? "unknown";
    const createdAt = new Date().toISOString();
    const snapshotContent = `${JSON.stringify({
      channels: uniqueSorted(channels),
      createdAt,
      environmentId,
      format: "science-agent-environment-revision-v1",
      language,
      ...(localWheels.length ? { localWheels } : {}),
      packages,
      platform: this.config.platform ?? `${process.platform}-${process.arch}`,
      provisioner: basename(this.provisionerPath),
      revisionId,
    }, null, 2)}\n`;
    const snapshotBytes = Buffer.from(snapshotContent);
    const snapshotHash = createHash("sha256").update(snapshotBytes).digest("hex");
    await writeFile(resolve(this.snapshotsRoot, `${revisionId}.json`), snapshotBytes, { flag: "wx" });
    const revision: EnvironmentRevision = {
      channels: uniqueSorted(channels),
      createdAt,
      environmentId,
      id: revisionId,
      language,
      languageVersion,
      ...(localWheels.length ? { localWheels: structuredClone(localWheels) } : {}),
      packages,
      packageSpecHash: snapshotHash,
      platform: this.config.platform ?? `${process.platform}-${process.arch}`,
      provisioner: basename(this.provisionerPath),
      runnerVersion: this.config.runnerVersion,
      snapshot: { hash: snapshotHash, size: snapshotBytes.length },
    };
    this.catalog.revisions.push(revision);
    return revision;
  }

  private requiredEnvironment(id: string): Environment {
    const environment = this.catalog.environments.find((candidate) => candidate.id === id);
    if (!environment) throw new Error(`Unknown scientific environment: ${id}`);
    return environment;
  }

  private requiredRevision(id: string): EnvironmentRevision {
    const revision = this.catalog.revisions.find((candidate) => candidate.id === id);
    if (!revision) throw new Error(`Unknown environment revision: ${id}`);
    return revision;
  }

  private revisionPath(environmentId: string, revisionId: string): string {
    if (!/^(?:starter-(?:python|r)|task-[a-f0-9-]+)$/.test(environmentId)
      || !/^rev-[a-f0-9-]+$/.test(revisionId)) {
      throw new Error("Environment metadata contains an unsafe identifier");
    }
    return resolve(this.revisionsRoot, environmentId, revisionId);
  }

  private offlineArguments(): string[] {
    return this.config.packageCacheDir ? ["--offline"] : [];
  }

  private async ensureManagedProvisioner(): Promise<void> {
    try {
      const bytes = await readFile(this.provisionerPath);
      const release = managedMicromambaRelease();
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== release.sha256) throw new Error("Managed provisioner failed SHA-256 verification");
      await access(this.provisionerPath, constants.X_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.provisionerInstaller(this.provisionerPath);
    }
    await this.validateProvisioner();
  }

  private async validateProvisioner(): Promise<void> {
    await access(this.provisionerPath, constants.X_OK).catch((error) => {
      throw new Error(`Scientific environment provisioner is unavailable: ${this.provisionerPath}`, { cause: error });
    });
  }

  private async validateStarter(language: ScientificLanguage): Promise<void> {
    const runtime = this.resolveRuntimeUnchecked(undefined, language);
    await access(runtime.interpreterPath, constants.X_OK);
    await this.snapshotBytes(runtime.revision.id);
  }

  private updateSetup(
    state: ScientificEnvironmentSetup["state"],
    phase: ScientificEnvironmentSetup["phase"],
    message: string,
    options: { completed?: boolean } = {},
  ): void {
    const now = new Date().toISOString();
    this.setupState = state;
    this.setupPhase = phase;
    this.setupMessage = message;
    this.setupUpdatedAt = now;
    if (options.completed) this.setupCompletedAt = now;
  }

  private failSetup(error: unknown): void {
    this.lastSetupError = error instanceof Error ? error.message : "Scientific environment setup failed";
    this.updateSetup("failed", "failed", "Managed Python environment setup failed", { completed: true });
  }

  private async runProvisioner(arguments_: string[], jobId: string): Promise<string> {
    return await this.provisioner(
      this.provisionerPath,
      ["--no-rc", ...arguments_],
      jobId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 128),
    );
  }

  private async runManagedCommand(executable: string, arguments_: string[], jobId: string): Promise<string> {
    const environment = { ...process.env };
    delete environment.PYTHONHOME;
    delete environment.PYTHONPATH;
    delete environment.PYTHONUSERBASE;
    return await this.provisioner(
      executable,
      arguments_,
      jobId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 128),
      environment,
    );
  }

  private async saveCatalog(): Promise<void> {
    const temporary = `${this.catalogPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.catalog, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.catalogPath);
  }
}

export const SCIENTIFIC_STARTER_PACKAGES = STARTER_PACKAGES;
export const MANAGED_MICROMAMBA_ARCHITECTURE_RELEASES = MANAGED_MICROMAMBA_RELEASES;
