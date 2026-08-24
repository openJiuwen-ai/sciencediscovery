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

/**
 * Shape of `manifest.json` at the payload root. The packaging script writes it
 * and the launcher reads it, so the two stay in step through this one type.
 */
export const PAYLOAD_MANIFEST_FILE = "manifest.json";
/**
 * Version 1 payloads embed the gateway dependency tree in the bundled
 * interpreter's site-packages. Version 2 payloads ship a `bootstrap` section
 * instead and restore those dependencies on the user's machine at first
 * launch. Both remain loadable so `SCIENCE_DISCOVERY_PAYLOAD_DIR` can keep
 * pointing at an already-extracted older payload.
 */
export const PAYLOAD_MANIFEST_FORMAT_VERSIONS = [1, 2] as const;

/** First-launch bootstrap inputs recorded by the packaging script. */
export interface PayloadBootstrap {
  /** uv is fetched as this pinned PyPI wheel and verified before use. */
  uv: { version: string; project: string; wheelFilename: string; wheelSha256: string };
  /** Payload-relative path of the hash-pinned gateway requirements export. */
  requirementsPath: string;
  /** Payload-relative path of the prebuilt sciencediscovery-gateway wheel. */
  gatewayWheelPath: string;
}

export interface PayloadManifest {
  formatVersion: number;
  product: string;
  /** Release version stamped by the packaging script. */
  version: string;
  /** Package architecture label: `x86_64` or `aarch64`. */
  architecture: string;
  /** `process.arch` value the payload runs on: `x64` or `arm64`. */
  runtimeArchitecture: string;
  node: { version: string; path: string };
  /**
   * `sitePackages` is descriptive only. The gateway's dependencies live inside
   * the bundled interpreter's own site directory, so nothing has to point at
   * them at run time; the field records where the packaging script put them
   * for anyone inspecting an extracted payload.
   */
  python: { version: string; path: string; sitePackages: string };
  micromamba?: { version: string; path: string };
  app: {
    root: string;
    apiEntry: string;
    runnerEntry: string;
    webDir: string;
  };
  /** Present from format version 2 on; absent in embedded-dependency payloads. */
  bootstrap?: PayloadBootstrap;
}

export function parsePayloadManifest(raw: string, source: string): PayloadManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  const manifest = value as Partial<PayloadManifest>;
  if (!PAYLOAD_MANIFEST_FORMAT_VERSIONS.includes(manifest?.formatVersion as 1 | 2)) {
    throw new Error(
      `${source} has payload format version ${String(manifest?.formatVersion)}; `
      + `this launcher understands versions ${PAYLOAD_MANIFEST_FORMAT_VERSIONS.join(", ")}.`,
    );
  }
  for (const field of ["version", "architecture", "runtimeArchitecture"] as const) {
    if (typeof manifest[field] !== "string" || !manifest[field]) {
      throw new Error(`${source} is missing the ${field} field.`);
    }
  }
  if (!manifest.node?.path || !manifest.python?.path || !manifest.app?.apiEntry) {
    throw new Error(`${source} is missing a runtime path entry.`);
  }
  if (manifest.formatVersion === 2) {
    const bootstrap = manifest.bootstrap;
    if (!bootstrap?.uv?.wheelFilename || !bootstrap.uv.wheelSha256 || !bootstrap.uv.version || !bootstrap.uv.project) {
      throw new Error(`${source} is missing the bootstrap uv wheel pin.`);
    }
    if (!bootstrap.requirementsPath || !bootstrap.gatewayWheelPath) {
      throw new Error(`${source} is missing a bootstrap artifact path entry.`);
    }
  }
  return manifest as PayloadManifest;
}
