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

import { execFileSync } from "node:child_process";

import type { ResolvedProxy } from "@science-agent/schema";

const CACHE_TTL_MS = 60_000;

export class SystemProxyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemProxyUnavailableError";
  }
}

type SystemProxyReader = () => ResolvedProxy;

let readerOverride: SystemProxyReader | undefined;
let cache: { at: number; error?: Error; value?: ResolvedProxy } | undefined;

export function setSystemProxyReaderForTest(reader: SystemProxyReader | undefined): void {
  readerOverride = reader;
  cache = undefined;
}

function gsettings(schema: string, key: string): string {
  return execFileSync("gsettings", ["get", schema, key], { encoding: "utf8", timeout: 1_000 }).trim();
}

/** Strip the GVariant string quoting gsettings prints ('like this'). */
function unquote(value: string): string {
  return value.replace(/^'(.*)'$/s, "$1");
}

/**
 * Read the desktop "system proxy" configuration. Only the GNOME
 * (gsettings) source is supported; headless servers without it get a
 * diagnosable error instead of a silent direct connection, so operators
 * know to switch the entry to environment or custom_url.
 */
function readGnomeSystemProxy(): ResolvedProxy {
  let mode: string;
  try {
    mode = unquote(gsettings("org.gnome.system.proxy", "mode"));
  } catch (error) {
    throw new SystemProxyUnavailableError(
      "System proxy settings are unavailable on this host (no readable desktop proxy configuration); "
      + `use an environment or custom URL proxy server instead: ${(error as Error).message}`,
    );
  }
  if (mode === "none") return { mode: "direct" };
  if (mode !== "manual") {
    throw new SystemProxyUnavailableError(
      `System proxy mode "${mode}" is not supported; configure a manual system proxy or use a custom URL entry`,
    );
  }
  for (const schema of ["org.gnome.system.proxy.https", "org.gnome.system.proxy.http"]) {
    const host = unquote(gsettings(schema, "host"));
    const port = Number.parseInt(gsettings(schema, "port"), 10);
    if (host && Number.isInteger(port) && port > 0) {
      return { mode: "url", url: `http://${host}:${port}` };
    }
  }
  throw new SystemProxyUnavailableError("The system proxy is set to manual but no proxy host is configured");
}

/** Resolve the OS-level proxy with a short cache so per-request resolution
 *  does not spawn gsettings repeatedly. Failures are cached too. */
export function resolveSystemProxy(now: number = Date.now()): ResolvedProxy {
  if (readerOverride) return readerOverride();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    if (cache.error) throw cache.error;
    return cache.value!;
  }
  try {
    const value = readGnomeSystemProxy();
    cache = { at: now, value };
    return value;
  } catch (error) {
    cache = { at: now, error: error as Error };
    throw error;
  }
}
