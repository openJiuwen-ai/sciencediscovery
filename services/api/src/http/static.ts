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

import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, resolve } from "node:path";

import { send, sendError } from "./response.js";

const FALLBACK_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ScienceDiscovery</title></head><body><main><h1>ScienceDiscovery API is running</h1><p>Build the web package with <code>pnpm build</code> to load the browser UI.</p><p><a href="/health">Health check</a></p></main></body></html>`;

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

export function contentTypeForPath(pathname: string): string {
  return MIME_TYPES[extname(pathname).toLowerCase()] ?? "application/octet-stream";
}

export async function serveStatic(response: ServerResponse, staticDir: string, pathname: string): Promise<void> {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const candidate = resolve(staticDir, requested);
  if (candidate !== staticDir && !candidate.startsWith(`${staticDir}/`)) {
    sendError(response, 400, "Invalid path");
    return;
  }
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) throw new Error("Not a file");
    send(response, 200, contentTypeForPath(candidate), await readFile(candidate));
  } catch {
    try {
      send(response, 200, "text/html; charset=utf-8", await readFile(resolve(staticDir, "index.html")));
    } catch {
      send(response, 200, "text/html; charset=utf-8", FALLBACK_PAGE);
    }
  }
}
