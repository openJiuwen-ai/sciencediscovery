// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { defaultBootstrapIo, ensureUv, resolveBootstrapSettings, withBootstrapLock, type BootstrapIo } from "./bootstrap.js";
import { EVOLVE_RELEASE, EVOLVE_REQUIREMENTS } from "./evolve-lock.js";
import type { PayloadManifest } from "./payload-manifest.js";

const MAX_INSTALL_BYTES = 1024 * 1024 * 1024;
const TIMEOUT = 10 * 60_000;
const MARKER = ".evolve-install.json";
const CHECK_RUNTIME = "import sciencediscovery_evolve.server, numpy, pandas, scipy, sklearn, pytest";

/** Isolated-mode candidate subprocesses need dependencies in their interpreter's own venv. */
export const EXTRACT_EVOLVE = String.raw`
import pathlib, sys, sysconfig, tarfile
archive, commit = sys.argv[1:]
root = "sciencediscovery-" + commit
prefix = root + "/services/evolve/src/"
destination = pathlib.Path(sysconfig.get_paths()["purelib"])
count = total = written = installed = 0
with tarfile.open(archive, "r|gz") as source:
    for member in source:
        count += 1
        total += member.size
        parts = pathlib.PurePosixPath(member.name).parts
        if count > 20000 or total > 256 * 1024 * 1024 or member.size > 64 * 1024 * 1024:
            raise ValueError("Evolve archive exceeds extraction limits")
        if not parts or parts[0] != root or ".." in parts or member.name.startswith("/") or "\\" in member.name:
            raise ValueError("Unsafe Evolve archive path")
        if not member.name.startswith(prefix):
            continue
        relative = pathlib.PurePosixPath(member.name[len(prefix):])
        if not relative.parts or relative.parts[0] != "sciencediscovery_evolve":
            raise ValueError("Unexpected Evolve source entry")
        target = destination.joinpath(*relative.parts)
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        elif member.isfile():
            written += member.size
            if written > 16 * 1024 * 1024:
                raise ValueError("Evolve source exceeds size limit")
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as src, target.open("xb") as dst:
                while chunk := src.read(65536):
                    dst.write(chunk)
            installed += 1
        else:
            raise ValueError("Links and special files are forbidden in Evolve source")
if not installed or not (destination / "sciencediscovery_evolve/server.py").is_file():
    raise ValueError("Evolve archive has no sidecar entry point")
`;

export interface EvolveInstallContext {
  dataDir: string;
  payloadRoot: string;
  manifest: PayloadManifest;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
  io?: BootstrapIo;
  signal?: AbortSignal;
}
export interface EvolveInstallation { python: string; root: string; token: string }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function evolveInstallRoot(context: EvolveInstallContext): string {
  return join(context.dataDir, "evolve", `${EVOLVE_RELEASE.sha256.slice(0, 12)}-${EVOLVE_RELEASE.requirementsSha256.slice(0, 12)}-${context.manifest.python.version}-${process.arch}`);
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error("Evolve installation directory must be a real directory");
  await chmod(path, 0o700);
}
export async function privateEvolveToken(dataDir: string): Promise<string> {
  const secrets = join(dataDir, "evolve", "secrets");
  await privateDirectory(secrets);
  const path = join(secrets, "internal-token");
  const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 128) throw new Error("Invalid Evolve credential file");
    await file.chmod(0o600);
    let token = (await file.readFile("utf8")).trim();
    if (!token) {
      token = randomBytes(32).toString("base64url");
      await file.write(`${token}\n`, 0, "utf8");
      await file.sync();
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid Evolve credential file");
    return token;
  } finally { await file.close(); }
}
async function installed(context: EvolveInstallContext): Promise<boolean> {
  try {
    const root = evolveInstallRoot(context);
    const marker = JSON.parse(await readFile(join(root, MARKER), "utf8")) as { archive?: string; requirements?: string };
    await access(join(root, "venv/bin/python"), constants.X_OK);
    return marker.archive === EVOLVE_RELEASE.sha256 && marker.requirements === EVOLVE_RELEASE.requirementsSha256;
  } catch { return false; }
}
async function download(io: BootstrapIo, destination: string): Promise<void> {
  const response = await io.fetch(EVOLVE_RELEASE.url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error("Evolve archive download failed");
  const hash = createHash("sha256");
  const file = await open(destination, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > EVOLVE_RELEASE.bytes) throw new Error("Evolve archive exceeds its pinned size");
      hash.update(chunk);
      await file.write(chunk);
    }
    if (bytes !== EVOLVE_RELEASE.bytes || hash.digest("hex") !== EVOLVE_RELEASE.sha256) throw new Error("Evolve archive checksum or size mismatch");
  } finally { await file.close(); }
}
async function directoryBytes(root: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    total += entry.isDirectory() ? await directoryBytes(path) : (await lstat(path)).size;
    if (total > MAX_INSTALL_BYTES) throw new Error("Evolve installation exceeds its disk limit");
  }
  return total;
}

/** restore never downloads. init is called only by the authenticated explicit user action. */
export async function resolveEvolveInstallation(context: EvolveInstallContext, initialize = false): Promise<EvolveInstallation | undefined> {
  const parent = join(context.dataDir, "evolve");
  await privateDirectory(parent);
  const baseIo = context.io ?? defaultBootstrapIo(context.log);
  const io: BootstrapIo = {
    ...baseIo,
    fetch: (input, init) => baseIo.fetch(input, { ...init, signal: context.signal
      ? AbortSignal.any([context.signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal }),
    run: (command, args, options) => baseIo.run(command, args, { ...options, signal: context.signal
      ? AbortSignal.any([context.signal, ...(options?.signal ? [options.signal] : [])]) : options?.signal }),
  };
  context.signal?.throwIfAborted();
  return await withBootstrapLock(parent, io, async () => {
    context.signal?.throwIfAborted();
    const root = evolveInstallRoot(context);
    let reusable = await installed(context);
    if (reusable) {
      try { await io.run(join(root, "venv/bin/python"), ["-I", "-c", CHECK_RUNTIME], { timeoutMs: 60_000 }); }
      catch { reusable = false; }
    }
    if (!reusable) {
      if (!initialize) return undefined;
      if (!context.manifest.bootstrap) throw new Error("This payload cannot initialize Evolve. Install a current ScienceDiscovery release.");
      if (digest(EVOLVE_REQUIREMENTS) !== EVOLVE_RELEASE.requirementsSha256) throw new Error("Evolve dependency lock checksum mismatch");
      const disk = await statfs(parent);
      if (disk.bavail * disk.bsize < MAX_INSTALL_BYTES) throw new Error("Evolve initialization needs at least 1 GiB of free disk space");
      const python = join(context.payloadRoot, context.manifest.python.path);
      const env = { ...context.env, PYTHONPATH: "", PYTHONHOME: "", PYTHONNOUSERSITE: "1", UV_PYTHON_DOWNLOADS: "never" };
      await io.run(python, ["-I", "-c", "import sys; assert sys.version_info >= (3,12), 'Evolve requires the bundled Python 3.12 or later'"], { env, timeoutMs: 10_000 });
      const uv = await ensureUv(io, resolveBootstrapSettings(context.env, context.dataDir), context.manifest.bootstrap, python);
      const staging = await mkdtemp(join(parent, ".install-"));
      try {
        context.log(`Downloading Evolve ${EVOLVE_RELEASE.release} and its pinned candidate runtime...`);
        await download(io, join(staging, "source.tar.gz"));
        await writeFile(join(staging, "requirements.txt"), EVOLVE_REQUIREMENTS, { mode: 0o600 });
        await io.run(uv, ["venv", "--relocatable", "--no-config", "--python", python, join(staging, "venv")], { env, timeoutMs: 60_000 });
        const interpreter = join(staging, "venv/bin/python");
        const diskBound = new AbortController();
        let scanning = false;
        const monitor = setInterval(() => {
          if (scanning) return;
          scanning = true;
          void directoryBytes(staging).catch(() => diskBound.abort()).finally(() => { scanning = false; });
        }, 2_000);
        try {
          await io.run(uv, ["pip", "install", "--no-config", "--no-cache", "--python", interpreter, "--require-hashes", "--only-binary", ":all:", "--index-url", resolveBootstrapSettings(context.env, context.dataDir).pypiIndex, "-r", join(staging, "requirements.txt")], { env: { ...env, TMPDIR: staging }, timeoutMs: TIMEOUT, signal: diskBound.signal });
        } finally { clearInterval(monitor); }

        await io.run(interpreter, ["-I", "-c", EXTRACT_EVOLVE, join(staging, "source.tar.gz"), EVOLVE_RELEASE.commit], { env, timeoutMs: 60_000 });
        await io.run(interpreter, ["-I", "-c", CHECK_RUNTIME], { env, timeoutMs: 60_000 });
        await rm(join(staging, "source.tar.gz"));
        await directoryBytes(staging);
        await writeFile(join(staging, MARKER), JSON.stringify({ archive: EVOLVE_RELEASE.sha256, requirements: EVOLVE_RELEASE.requirementsSha256 }), { mode: 0o600 });
        // Only an incomplete same-pin install can occupy this path; valid ones returned above.
        await rm(root, { recursive: true, force: true });
        await rename(staging, root);
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    return { root, python: join(root, "venv/bin/python"), token: await privateEvolveToken(context.dataDir) };
  }, context.signal);
}
