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
import { EnvironmentAccess } from "./environment-access.js";

const execFileAsync = promisify(execFile);
const CATALOG_VERSION = 1;
const MANAGED_MICROMAMBA_VERSION = micromambaManifest.version;
const MANAGED_MICROMAMBA_BASE_URL = `${micromambaManifest.baseUrl}/${MANAGED_MICROMAMBA_VERSION}`;
const MANAGED_MICROMAMBA_RELEASES = micromambaManifest.releases;
const MANAGED_MICROMAMBA_DARWIN_RELEASES = micromambaManifest.darwinReleases;
const MAX_PROVISIONER_BYTES = 64 * 1024 * 1024;
/** One provisioner download; long enough for a slow mirror, short enough to fail. */
const MANAGED_PROVISIONER_TIMEOUT_MS = 120_000;
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
  channel?: string;
  url?: string;
  sha256?: string;
  md5?: string;
}

interface ProvisionedPackageListEnvelope {
  packages?: unknown;
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

/**
 * Where the pinned micromamba release is fetched from.
 *
 * An installation whose machines cannot reach the upstream release host points
 * this at a mirror serving the same file names. The pinned SHA-256 is still
 * enforced, so a mirror can host the release but cannot change it.
 */
export function managedMicromambaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SCIENCE_AGENT_MICROMAMBA_BASE_URL?.trim().replace(/\/+$/, "");
  return configured || MANAGED_MICROMAMBA_BASE_URL;
}

/** Where a Runner keeps the managed provisioner inside its data directory. */
export function managedProvisionerPath(dataDir: string): string {
  return resolve(dataDir, "scientific-envs", "bin", "micromamba");
}

export function managedMicromambaRelease(
  architecture: string = process.arch,
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
) {
  const releases = platform === "linux"
    ? MANAGED_MICROMAMBA_RELEASES
    : platform === "darwin" ? MANAGED_MICROMAMBA_DARWIN_RELEASES : undefined;
  if (!releases) throw new Error(`Managed micromamba installation is unavailable for platform ${platform}`);
  const release = releases[architecture as keyof typeof releases];
  if (!release) {
    throw new Error(`Managed micromamba installation is unavailable for architecture ${architecture}`);
  }
  return {
    ...release,
    url: `${managedMicromambaBaseUrl(env)}/${release.filename}`,
    version: MANAGED_MICROMAMBA_VERSION,
  };
}

/**
 * Which step of the provisioner install failed. The three have nothing in
 * common for whoever has to fix them — an unreachable host, a mirror serving
 * something else, and a data directory the Runner cannot write are different
 * problems — so the guidance differs and the caller must be able to tell them
 * apart without parsing a message.
 */
export type ManagedProvisionerFailure = "download" | "verify" | "write";

export class ManagedProvisionerError extends Error {
  readonly failure: ManagedProvisionerFailure;
  /** The release the Runner tried to install, so the message can name it. */
  readonly url: string;

  constructor(failure: ManagedProvisionerFailure, url: string, detail: string, cause?: unknown) {
    super(failure === "download"
      ? `Could not download the micromamba provisioner from ${url}: ${detail}`
      : failure === "verify"
        ? `The micromamba provisioner downloaded from ${url} is not the pinned release: ${detail}`
        : `Could not install the micromamba provisioner: ${detail}`, cause === undefined ? undefined : { cause });
    this.name = "ManagedProvisionerError";
    this.failure = failure;
    this.url = url;
  }
}

/**
 * What actually went wrong underneath a failed `fetch`.
 *
 * Node reports every transport failure as `TypeError: fetch failed` and keeps
 * the real reason — DNS, refused connection, TLS, timeout — in `cause`, often
 * nested a level deeper. Reporting only the top-level message is what made an
 * unreachable release host indistinguishable from a broken proxy or an expired
 * certificate, so the chain is walked and the first thing with substance wins.
 */
export function describeFetchFailure(error: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = error;
  const parts: string[] = [];
  while (current && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; errno?: unknown; message?: unknown; name?: unknown; cause?: unknown };
    if (candidate.name === "AbortError" || candidate.name === "TimeoutError") {
      return `the download timed out after ${MANAGED_PROVISIONER_TIMEOUT_MS / 1000}s`;
    }
    if (typeof candidate.code === "string") parts.push(candidate.code);
    if (typeof candidate.message === "string" && candidate.message && candidate.message !== "fetch failed") {
      parts.push(candidate.message);
    }
    current = candidate.cause;
  }
  // Keep the first concrete reason; the rest of the chain repeats it.
  return parts.find((part) => part !== "fetch failed") ?? "the connection failed";
}

export async function installManagedMicromamba(
  destination: string,
  fetcher: typeof fetch = fetch,
  architecture: string = process.arch,
  platform: string = process.platform,
): Promise<void> {
  const release = managedMicromambaRelease(architecture, platform);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MANAGED_PROVISIONER_TIMEOUT_MS);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.download`;
  try {
    let response: Response;
    try {
      response = await fetcher(release.url, { redirect: "follow", signal: controller.signal });
    } catch (error) {
      throw new ManagedProvisionerError("download", release.url, describeFetchFailure(error), error);
    }
    if (!response.ok) {
      throw new ManagedProvisionerError("download", release.url, `the server answered HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_PROVISIONER_BYTES) {
      throw new ManagedProvisionerError("verify", release.url,
        `the release is larger than the ${MAX_PROVISIONER_BYTES} byte limit`);
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new ManagedProvisionerError("download", release.url, describeFetchFailure(error), error);
    }
    if (!bytes.length || bytes.length > MAX_PROVISIONER_BYTES) {
      throw new ManagedProvisionerError("verify", release.url, `the download is ${bytes.length} bytes`);
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== release.sha256) {
      throw new ManagedProvisionerError("verify", release.url,
        `expected SHA-256 ${release.sha256}, got ${hash}`);
    }
    try {
      await mkdir(resolve(destination, ".."), { recursive: true });
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o700 });
      await chmod(temporary, 0o700);
      await rename(temporary, destination);
    } catch (error) {
      throw new ManagedProvisionerError("write", release.url,
        `${destination} could not be written: ${(error as NodeJS.ErrnoException).code ?? String(error)}`, error);
    }
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

function parseProvisionedPackageList(listOutput: string): ProvisionedPackage[] {
  const parsed = JSON.parse(listOutput || "[]") as unknown;
  const listed = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as ProvisionedPackageListEnvelope).packages)
      ? (parsed as ProvisionedPackageListEnvelope).packages
      : undefined;
  if (!listed) throw new Error("Provisioner package list must be a JSON array or an object with a packages array");
  return listed as ProvisionedPackage[];
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
  private setupComponents: ScientificEnvironmentSetup["components"];
  private setupPromise?: Promise<ScientificEnvironmentSetup>;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly runtimeAccess = new EnvironmentAccess();
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
    const initialComponentState = config.enabled ? "not-configured" : "disabled";
    const initialComponentPhase = config.enabled ? "pending" : "disabled";
    this.setupComponents = {
      conda: this.createSetupComponent(
        initialComponentState,
        initialComponentPhase,
        config.enabled ? "Conda environments are waiting for the Python base" : "Conda environments are disabled by configuration",
      ),
      micromamba: this.createSetupComponent(
        initialComponentState,
        initialComponentPhase,
        config.enabled ? "micromamba is waiting to be checked or installed" : "micromamba is disabled by configuration",
      ),
    };
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
      components: structuredClone(this.setupComponents),
      error: this.lastSetupError ?? null,
      ...(this.lastSetupError ? { lastError: this.lastSetupError } : {}),
      managedProvisioner: !this.config.provisionerPath,
      message: this.setupMessage,
      networkPolicy: this.config.packageCacheDir ? "offline-cache" : "allowed-channels",
      phase: this.setupPhase,
      provisioner: this.setupComponents.micromamba.state === "ready" ? basename(this.provisionerPath) : null,
      provisionerVersion: !this.config.provisionerPath && this.setupComponents.micromamba.state === "ready"
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
    await mkdir(resolve(this.config.root, "provisioner", "pkgs"), { recursive: true });
    await this.loadCatalog();
    if (this.catalog.environments.some((environment) => environment.id === "starter-python")) {
      let component: keyof ScientificEnvironmentSetup["components"] = "micromamba";
      try {
        this.updateSetupComponent("micromamba", "installing", "checking", "Checking the micromamba executable", { started: true });
        await this.validateProvisioner();
        this.updateSetupComponent("micromamba", "ready", "complete", "micromamba is ready", { completed: true });
        component = "conda";
        this.updateSetupComponent("conda", "installing", "verifying-python-base", "Verifying the managed Python base", { started: true });
        await this.validateStarter("python");
        this.updateSetupComponent("conda", "ready", "complete", "Conda environments are ready", { completed: true });
        this.updateSetup("ready", "complete", "Python base environment is ready", { completed: true });
      } catch (error) {
        this.failSetup(error, component);
      }
    }
    this.initialized = true;
  }

  startManagedEnvironmentSetup(): ScientificEnvironmentSetup {
    if (!this.config.enabled) return this.setup;
    if (this.setupPromise || this.setupState === "ready") return this.setup;
    if (!this.config.allowedChannels.length) {
      this.failSetup(new Error("Scientific environments require at least one allowed package channel"), "conda");
      return this.setup;
    }
    this.lastSetupError = undefined;
    this.setupStartedAt = new Date().toISOString();
    this.setupCompletedAt = null;
    this.updateSetupComponent("micromamba", "installing", "checking", "Checking the micromamba executable", { started: true });
    this.updateSetupComponent("conda", "not-configured", "pending", "Conda environments are waiting for micromamba");
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
    let component: keyof ScientificEnvironmentSetup["components"] = "micromamba";
    try {
      if (this.config.provisionerPath) {
        this.updateSetup("installing", "checking", "Checking configured micromamba provisioner");
        this.updateSetupComponent("micromamba", "installing", "checking", "Checking the configured micromamba executable");
        await this.validateProvisioner();
      } else {
        this.updateSetup("installing", "downloading-provisioner", "Downloading and verifying managed micromamba");
        this.updateSetupComponent("micromamba", "installing", "downloading-provisioner", "Downloading and verifying managed micromamba");
        await this.ensureManagedProvisioner();
      }
      this.updateSetupComponent("micromamba", "ready", "complete", "micromamba is ready", { completed: true });
      component = "conda";
      if (this.config.packageCacheDir) await access(this.config.packageCacheDir);
      if (!this.catalog.environments.some((environment) => environment.id === "starter-python")) {
        this.updateSetup("installing", "creating-python-base", "Creating the managed Python base environment");
        this.updateSetupComponent("conda", "installing", "creating-python-base", "Creating the managed Python base environment", { started: true });
        await this.bootstrapStarter("python");
      }
      this.updateSetup("installing", "verifying-python-base", "Verifying the managed Python base environment");
      this.updateSetupComponent("conda", "installing", "verifying-python-base", "Verifying the managed Python base environment", { started: true });
      await this.validateStarter("python");
      this.initialized = true;
      this.updateSetupComponent("conda", "ready", "complete", "Conda environments are ready", { completed: true });
      this.updateSetup("ready", "complete", "Python base environment is ready", { completed: true });
      return this.setup;
    } catch (error) {
      this.initialized = true;
      this.failSetup(error, component);
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

  /** Resolve the latest state after obtaining the lease, never before a queued update. */
  async withRuntime<T>(environmentId: string, operation: (runtime: EnvironmentRuntime) => Promise<T>): Promise<T> {
    return this.runtimeAccess.run(environmentId, false, async () => {
      this.assertAvailable();
      const environment = this.requiredEnvironment(environmentId);
      return operation(this.resolveRuntimeUnchecked(environment.currentRevisionId, environment.language));
    });
  }

  private resolveRuntimeUnchecked(revisionId: string | undefined, language: ScientificLanguage): EnvironmentRuntime {
    const revision = revisionId
      ? this.requiredRevision(revisionId)
      : this.requiredRevision(this.requiredEnvironment(`starter-${language}`).currentRevisionId);
    if (revision.language !== language) {
      throw new Error(`Environment revision ${revision.id} is ${revision.language}, not ${language}`);
    }
    const environment = this.requiredEnvironment(revision.environmentId);
    if (environment.currentRevisionId !== revision.id) {
      throw new Error("Historical environment revisions are audit-only; select an environment ID to use its latest state");
    }
    if (environment.status && environment.status !== "ready") {
      throw new Error(`Environment ${environment.id} is ${environment.status}; repair it with environment management before execution`);
    }
    const prefixPath = this.revisionPath(environment.id, environment.runtimeRevisionId ?? revision.id);
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
        "create", "--yes", ...this.offlineArguments(), "--clone", this.revisionPath(base.id, base.runtimeRevisionId ?? base.currentRevisionId), "--prefix", prefix,
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
    await this.runtimeAccess.run(id, true, () => this.enqueueMutation(() => this.deleteTaskUnlocked(id)));
  }

  private async deleteTaskUnlocked(id: string): Promise<void> {
    this.assertAvailable();
    const environment = this.requiredEnvironment(id);
    if (environment.kind === "starter") throw new Error("Starter environments cannot be deleted");
    const previousCatalog = structuredClone(this.catalog);
    this.catalog.environments = this.catalog.environments.filter((candidate) => candidate.id !== id);
    // Removing an executable prefix must not erase the revisions used by past runs.
    // Snapshots and available source artifacts remain audit-only records.
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
    return await this.runtimeAccess.run(id, true, () => this.enqueueMutation(
      () => this.installUnlocked(id, packages, requestedChannels, manager, workspaceRoot, indexUrl),
    ));
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
    if (manager === "pip" && requestedChannels?.length) {
      throw new Error("channels can only be used with manager=conda");
    }
    if (indexUrl !== undefined && manager !== "pip") throw new Error("indexUrl can only be used with manager=pip");
    const normalizedIndexUrl = manager === "pip" && indexUrl !== undefined
      ? normalizePipIndexUrl(indexUrl)
      : externalUrl("package_indexes.pypi_simple");
    if (manager !== "conda") {
      const executable = manager === "pip" ? "python" : "R";
      await access(resolve(this.revisionPath(id, environment.runtimeRevisionId ?? environment.currentRevisionId), "bin", executable), constants.X_OK)
        .catch(() => { throw new Error(`Environment lacks ${executable}; install it with manager=conda first`); });
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
    const revisionId = `rev-${randomUUID()}`;
    const prefix = this.revisionPath(id, environment.runtimeRevisionId ?? previousRevision.id);
    await this.beginUpdate(environment);
    try {
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
      environment.status = "ready";
      delete environment.error;
      environment.updatedAt = new Date().toISOString();
      await this.saveCatalog();
      return { ...revision };
    } catch (error) {
      await this.failUpdate(environment, previousRevision.id);
      throw error;
    }
  }

  async uninstall(id: string, packages: string[]): Promise<EnvironmentRevision> {
    return await this.runtimeAccess.run(id, true, () => this.enqueueMutation(() => this.uninstallUnlocked(id, packages)));
  }

  private async uninstallUnlocked(id: string, packages: string[]): Promise<EnvironmentRevision> {
    this.assertAvailable();
    const environment = this.requiredEnvironment(id);
    if (environment.kind === "starter") throw new Error("Starter environments are read-only; create a task environment first");
    const normalizedPackages = uniqueSorted(packages.map(safePackage));
    if (!normalizedPackages.length) throw new Error("At least one package is required");
    const previousRevision = this.currentRevision(id);
    const revisionId = `rev-${randomUUID()}`;
    const prefix = this.revisionPath(id, environment.runtimeRevisionId ?? previousRevision.id);
    await this.beginUpdate(environment);
    try {
      await this.runProvisioner([
        "remove", "--yes", ...this.offlineArguments(), "--prefix", prefix, ...normalizedPackages,
      ], `uninstall-${revisionId}`);
      const revision = await this.recordRevision(
        id,
        revisionId,
        environment.language,
        prefix,
        previousRevision.channels,
        normalizedPackages.map((name) => `conda:remove:${name}`),
        previousRevision.localWheels,
      );
      environment.currentRevisionId = revision.id;
      environment.status = "ready";
      delete environment.error;
      environment.updatedAt = new Date().toISOString();
      await this.saveCatalog();
      return { ...revision };
    } catch (error) {
      await this.failUpdate(environment, previousRevision.id);
      throw error;
    }
  }

  private assertAvailable(): void {
    if (!this.config.enabled || !this.initialized || !this.capability.available) {
      throw new Error(this.capability.unavailableReason ?? "Scientific environments are unavailable");
    }
  }

  private async beginUpdate(environment: Environment): Promise<void> {
    environment.runtimeRevisionId ??= environment.currentRevisionId;
    environment.status = "updating";
    delete environment.error;
    // Persist the marker before any package-manager side effect. Restart is fail-closed.
    await this.saveCatalog();
  }

  private async failUpdate(environment: Environment, previousRevisionId: string): Promise<void> {
    environment.currentRevisionId = previousRevisionId;
    environment.status = "failed";
    environment.error = "In-place update failed; installed files may differ from the last successful revision. Retry through environment management.";
    environment.updatedAt = new Date().toISOString();
    await this.saveCatalog();
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
      for (const environment of this.catalog.environments) {
        if (environment.status === "updating") {
          environment.status = "failed";
          environment.error = "Environment update was interrupted; repair through environment management before execution.";
        }
      }
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
    const listed = parseProvisionedPackageList(listOutput);
    const pythonPath = resolve(prefix, "bin", "python");
    const rPath = resolve(prefix, "bin", "R");
    const pythonInstalled = await access(pythonPath, constants.X_OK).then(() => true, () => false);
    const rInstalled = await access(rPath, constants.X_OK).then(() => true, () => false);
    const python = pythonInstalled ? JSON.parse(await this.runManagedCommand(pythonPath, ["-I", "-c",
      "import importlib.metadata as m,json; print(json.dumps(sorted([{'name':d.metadata['Name'],'version':d.version,'installer':(d.read_text('INSTALLER') or '').strip()} for d in m.distributions()],key=lambda d:d['name'] or '')))"
    ], `python-inventory-${revisionId}`)) as Array<{ name: string; version: string; installer: string }> : [];
    if (!Array.isArray(python) || python.some((p) => !p.name || !p.version)) throw new Error("Invalid Python package inventory");
    const rOutput = rInstalled ? await this.runManagedCommand(rPath, ["--vanilla", "--slave", "-e",
      'p <- installed.packages(fields="Repository"); write.table(p[,c("Package","Version","Repository"),drop=FALSE],stdout(),sep="\\t",row.names=FALSE,col.names=FALSE,quote=FALSE)'
    ], `r-inventory-${revisionId}`) : "";
    const r = rOutput.trim() ? rOutput.trim().split("\n").map((line) => {
      const [name, version, repository] = line.split("\t");
      if (!name || !version) throw new Error("Invalid R package inventory");
      return { name, version, repository };
    }) : [];
    const packages = uniqueSorted([...listed.flatMap((item) => item.name && item.version
      ? [`${item.name}=${item.version}${item.build_string ? `=${item.build_string}` : ""}`]
      : []), ...python.map((p) => `python:${p.name}==${p.version}`), ...r.map((p) => `r:${p.name}==${p.version}`)]);
    const languagePackage = packages.find((item) => item.startsWith(language === "python" ? "python=" : "r-base="));
    const languageVersion = languagePackage?.split("=")[1] ?? "unknown";
    const createdAt = new Date().toISOString();
    const snapshotContent = `${JSON.stringify({
      channels: uniqueSorted(channels),
      createdAt,
      environmentId,
      format: "sciencediscovery-environment-revision-v2",
      installed: { conda: listed, python, r },
      requestedChanges: additionalPackages,
      reconstruction: { status: "reference-only", reason: "Package inventory is retained; remote installation artifacts are not guaranteed to remain available." },
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
    if (revision) return revision;
    // The caller reads these ids out of a listing and types one back, and they
    // are 36-character UUIDs: a single transposed character is the likely
    // mistake, and "unknown revision" alone leaves nothing to correct with —
    // seen live, an agent guessing at a second id after the first was a typo of
    // a revision that did exist. The known ids are right here, so say them.
    const known = this.catalog.revisions.map((candidate) => candidate.id);
    throw new Error(
      `Unknown environment revision: ${id}.`
      + (known.length
        ? ` Known revisions: ${known.slice(0, 10).join(", ")}${known.length > 10 ? ", …" : ""}`
        : " No environment revisions exist yet; create one before running against it."),
    );
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
    const release = managedMicromambaRelease();
    let installed: string | undefined;
    try {
      const bytes = await readFile(this.provisionerPath);
      const hash = createHash("sha256").update(bytes).digest("hex");
      // A file that is not the pinned release is replaced, not raised. It is a
      // managed path the Runner owns: a half-finished transfer, a version this
      // build no longer pins, or a copy seeded for another architecture all
      // leave something here that only reinstalling can fix, and stopping with
      // "verification failed" left the machine stuck on it forever.
      if (hash !== release.sha256) installed = `replaced a file that was not the pinned ${release.version} release`;
      else await access(this.provisionerPath, constants.X_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") installed = "installed";
      else if ((error as NodeJS.ErrnoException).code === "EACCES") installed = "replaced a file the Runner could not execute";
      else throw error;
    }
    if (installed) {
      await rm(this.provisionerPath, { force: true }).catch(() => undefined);
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

  private createSetupComponent(
    state: ScientificEnvironmentSetup["state"],
    phase: ScientificEnvironmentSetup["phase"],
    message: string,
  ): ScientificEnvironmentSetup["components"]["conda"] {
    return {
      action: null,
      completedAt: null,
      error: null,
      message,
      phase,
      startedAt: null,
      state,
      updatedAt: this.setupUpdatedAt,
    };
  }

  private updateSetupComponent(
    component: keyof ScientificEnvironmentSetup["components"],
    state: ScientificEnvironmentSetup["state"],
    phase: ScientificEnvironmentSetup["phase"],
    message: string,
    options: { action?: string; completed?: boolean; error?: string; started?: boolean } = {},
  ): void {
    const now = new Date().toISOString();
    const current = this.setupComponents[component];
    this.setupComponents[component] = {
      action: options.action ?? null,
      completedAt: options.completed ? now : null,
      error: options.error ?? null,
      message,
      phase,
      startedAt: options.started && !current.startedAt ? now : current.startedAt,
      state,
      updatedAt: now,
    };
  }

  private failSetup(error: unknown, component: keyof ScientificEnvironmentSetup["components"]): void {
    this.lastSetupError = error instanceof Error ? error.message : "Scientific environment setup failed";
    const micromambaFailure = component === "micromamba";
    const message = micromambaFailure ? "micromamba setup failed" : "Conda environment setup failed";
    const action = micromambaFailure
      ? this.provisionerAction(error)
      : "Check free disk space and write permissions in the Runner data directory, then the configured Conda channels or offline cache, and retry setup. Existing system Conda and shell settings are not modified.";
    this.updateSetupComponent(component, "failed", "failed", message, {
      action,
      completed: true,
      error: this.lastSetupError,
    });
    this.updateSetup("failed", "failed", message, { completed: true });
  }

  /**
   * What the operator can actually do next. "Retry" was the only advice this
   * gave, which is useless on a machine that has no route to the release host:
   * retrying fails identically forever, and nothing said that a mirror, a
   * pre-placed executable or the control plane's own copy would fix it.
   */
  private provisionerAction(error: unknown): string {
    if (this.config.provisionerPath) {
      return `Verify that ${this.config.provisionerPath} exists on this machine, is executable by the Runner user, and is the pinned micromamba release, then retry setup.`;
    }
    const failure = error instanceof ManagedProvisionerError ? error.failure : undefined;
    if (failure === "download") {
      return `This machine could not reach the release. Either give it a route, point SCIENCE_AGENT_MICROMAMBA_BASE_URL at a mirror it can reach, or place the pinned micromamba at ${this.provisionerPath} (a Runner deployed over SSH is seeded with it automatically when the control plane can reach the release). Then retry setup.`;
    }
    if (failure === "verify") {
      return "The downloaded file is not the pinned release. If SCIENCE_AGENT_MICROMAMBA_BASE_URL points at a mirror, check that the mirror serves the pinned version unmodified, then retry setup.";
    }
    if (failure === "write") {
      return `The Runner user could not write ${this.provisionerPath}. Check ownership, permissions and free space on the Runner data directory, then retry setup.`;
    }
    return "Retry setup. If it fails again, verify access to the pinned micromamba release and write access to the application data directory.";
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
