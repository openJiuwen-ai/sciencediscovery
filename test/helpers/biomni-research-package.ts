// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { get as httpGet, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { importResearchPackageStreamed, RESEARCH_PACKAGE_TOO_LARGE_CODE } from "../../packages/research-package/src/index.ts";

// The API can spend several minutes measuring and preparing a large export
// before sending headers. Use one deadline for headers, download and validation.
function openPackage(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const get = url.protocol === "https:" ? httpsGet : httpGet;
    get(url, { headers, signal }, resolve).once("error", reject);
  });
}

async function isPackageOverCap(response: IncomingMessage): Promise<boolean> {
  if (response.statusCode !== 413) return false;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 8192) return false;
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"))?.code === RESEARCH_PACKAGE_TOO_LARGE_CODE;
  } catch {
    return false;
  }
}

export async function exportBiomniResearchPackage(options: {
  baseUrl: string;
  headers: Record<string, string>;
  projectId: string;
  sessionId: string;
  destination: string;
  timeoutMs: number;
}) {
  const { baseUrl, headers, projectId, sessionId, destination, timeoutMs } = options;
  const url = new URL(`/api/projects/${encodeURIComponent(projectId)}/research-package`, baseUrl);
  // Match Web's Complete export with both optional switches off.
  url.search = new URLSearchParams({ sessionId, level: "complete", includeFullTrajectory: "0", includeFullMemoryGraph: "0" }).toString();
  const signal = AbortSignal.timeout(timeoutMs);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(join(dirname(destination), ".research-package-"));
  try {
    const partial = join(temporary, "package.partial");
    let response = await openPackage(url, headers, signal);
    const acknowledgedSizeLimit = await isPackageOverCap(response);
    if (acknowledgedSizeLimit) {
      // Match the Web acknowledgement. The API still enforces its hard ceiling
      // and capacity checks, and both requests share the same deadline.
      url.searchParams.set("allowOverCap", "1");
      response = await openPackage(url, headers, signal);
    }
    if (response.statusCode !== 200) {
      response.destroy();
      throw new Error(acknowledgedSizeLimit && response.statusCode === 413
        ? "Research package exceeds the hard archive size limit"
        : `Research package export returned HTTP ${response.statusCode}`);
    }
    await pipeline(response, createWriteStream(partial, { flags: "wx", mode: 0o600 }), { signal });
    const validated = await importResearchPackageStreamed(createReadStream(partial, { signal }), {
      objectDirectory: join(temporary, "objects"), signal,
    });
    const { manifest, receipt } = validated;
    if (manifest.packageKind !== "evidence" || manifest.source.projectId !== projectId ||
        manifest.source.sessionIds?.length !== 1 || manifest.source.sessionIds[0] !== sessionId ||
        manifest.exportProfile?.level !== "complete" || manifest.exportProfile.capabilities.fullTrajectory ||
        manifest.exportProfile.capabilities.fullMemoryGraph) {
      throw new Error("Research package scope or export options did not match the L5 request");
    }
    const { size } = await stat(partial);
    await rename(partial, destination);
    return { size_bytes: size, sha256: receipt.packageChecksum, omissions: manifest.omissions,
      ...(acknowledgedSizeLimit ? { acknowledged_size_limit: true } : {}) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
