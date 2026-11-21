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
 * A small client for the parts of the GitCode v5 API the snapshot sync needs.
 *
 * Anonymous access allows 50 calls a minute per user, and a full snapshot is
 * roughly 400 calls, so every request goes through one limiter. The sync would
 * rather take eight minutes than be throttled halfway through.
 */

export interface GitCodeClientOptions {
  apiBase?: string;
  fetcher?: typeof fetch;
  ref?: string;
  repo: string;
  /** Requests started per minute; the anonymous quota is 50. */
  requestsPerMinute?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  token?: string;
}

export interface GitCodeClient {
  commit(): Promise<string>;
  file(path: string, ref?: string): Promise<Uint8Array>;
  listDirectories(path: string, ref?: string): Promise<string[]>;
}

interface ContentsEntry {
  name: string;
  path: string;
  type: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createGitCodeClient(options: GitCodeClientOptions): GitCodeClient {
  const apiBase = (options.apiBase ?? "https://api.gitcode.com/api/v5").replace(/\/+$/, "");
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const intervalMs = Math.ceil(60_000 / (options.requestsPerMinute ?? 45));
  const retryDelayMs = options.retryDelayMs ?? 60_000;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  let nextStart = 0;
  async function pace(): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, nextStart);
    nextStart = start + intervalMs;
    if (start > now) await sleep(start - now);
  }

  async function get(pathname: string, query = ""): Promise<Response> {
    const url = `${apiBase}/repos/${options.repo}${pathname}${query}`;
    for (let attempt = 1; ; attempt += 1) {
      await pace();
      let response: Response;
      try {
        response = await fetcher(url, { headers });
      } catch (error) {
        if (attempt >= 4) throw new Error(`GitCode request failed: ${pathname} (${String(error)})`);
        await sleep(2_000 * 4 ** (attempt - 1));
        continue;
      }
      if (response.status === 429) {
        if (attempt >= 6) throw new Error(`GitCode rate limit did not clear: ${pathname}`);
        await sleep(retryDelayMs);
        continue;
      }
      if (response.status >= 500) {
        if (attempt >= 4) throw new Error(`GitCode server error ${response.status}: ${pathname}`);
        await sleep(2_000 * 4 ** (attempt - 1));
        continue;
      }
      if (!response.ok) throw new Error(`GitCode ${response.status}: ${pathname}`);
      return response;
    }
  }

  function refQuery(ref: string | undefined): string {
    return ref ? `?ref=${encodeURIComponent(ref)}` : "";
  }

  return {
    async commit(): Promise<string> {
      const ref = options.ref ?? "master";
      const body = await (await get(`/branches/${encodeURIComponent(ref)}`)).json() as { commit?: { id?: string } };
      if (!body.commit?.id) throw new Error(`GitCode branch ${ref} has no commit id`);
      return body.commit.id;
    },

    async file(path: string, ref?: string): Promise<Uint8Array> {
      const body = await (await get(`/contents/${path}`, refQuery(ref))).json() as ContentsEntry & {
        content?: string;
        encoding?: string;
      };
      if (body.type !== "file" || typeof body.content !== "string") throw new Error(`GitCode ${path} is not a file`);
      if (body.encoding && body.encoding !== "base64") throw new Error(`GitCode ${path} has unexpected encoding ${body.encoding}`);
      const bytes = Buffer.from(body.content.replace(/\s+/g, ""), "base64");
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
    },

    async listDirectories(path: string, ref?: string): Promise<string[]> {
      const body = await (await get(`/contents/${path}`, refQuery(ref))).json() as ContentsEntry[];
      if (!Array.isArray(body)) throw new Error(`GitCode ${path} is not a directory`);
      return body.filter((entry) => entry.type === "dir").map((entry) => entry.name).toSorted();
    },
  };
}
