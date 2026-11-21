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
 * The two ways this service is entered.
 *
 * `createFunctionHandler` is the FunctionGraph entry point: the platform hands
 * over an event object and expects a `{statusCode, headers, body}` reply.
 * `startServer` is the same app behind `node:http` on port 4400, so the admin
 * console and the client can be exercised without deploying anything.
 */

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { createApp } from "./app.js";
import { loadConfig, type AccountsConfig } from "./config.js";
import { Database } from "./db.js";
import { applySchema } from "./schema.js";
import { PostgresStore } from "./store.js";
import type { HttpRequest, HttpResponse } from "./http.js";

export interface FunctionGraphEvent {
  httpMethod?: string;
  path?: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { httpMethod?: string; path?: string; identity?: { sourceIp?: string } };
}

export interface FunctionGraphResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

export function normalizePath(raw: string): string {
  const withoutQuery = raw.split("?")[0] ?? "/";
  const withRoot = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  return withRoot.length > 1 ? withRoot.replace(/\/+$/u, "") : withRoot;
}

export function toHttpRequest(event: FunctionGraphEvent): HttpRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (typeof value === "string") headers[name.toLowerCase()] = value;
  }
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(event.queryStringParameters ?? {})) {
    if (typeof value === "string") query.append(name, value);
  }
  const forwarded = headers["x-forwarded-for"]?.split(",")[0]?.trim();
  return {
    method: (event.httpMethod ?? event.requestContext?.httpMethod ?? "GET").toUpperCase(),
    path: normalizePath(event.path ?? event.requestContext?.path ?? "/"),
    query,
    headers,
    body: event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64") : Buffer.from(event.body ?? "", "utf8"),
    ip: forwarded || event.requestContext?.identity?.sourceIp || null,
  };
}

export function toFunctionResult(response: HttpResponse): FunctionGraphResult {
  if (typeof response.body === "string") {
    return { statusCode: response.status, headers: response.headers, body: response.body, isBase64Encoded: false };
  }
  return { statusCode: response.status, headers: response.headers, body: response.body.toString("base64"), isBase64Encoded: true };
}

/**
 * FunctionGraph replies are single objects, so a streamed reply is collected
 * first. The local server keeps the stream and writes chunk by chunk.
 */
async function collectStream(response: HttpResponse): Promise<HttpResponse> {
  if (!response.stream) return response;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.stream) chunks.push(chunk);
  return { status: response.status, headers: response.headers, body: Buffer.concat(chunks) };
}

export function createFunctionHandler(config: AccountsConfig = loadConfig()) {
  const database = new Database(config.databaseUrl);
  const app = createApp({ config, store: new PostgresStore(database) });
  let schemaReady: Promise<void> | undefined;

  return async (event: FunctionGraphEvent): Promise<FunctionGraphResult> => {
    try {
      schemaReady ??= applySchema(database).catch((error: unknown) => {
        schemaReady = undefined;
        throw error;
      });
      await schemaReady;
      return toFunctionResult(await collectStream(await app(toHttpRequest(event))));
    } catch (error) {
      console.error("accounts function failed", error instanceof Error ? error.stack ?? error.message : error);
      return { statusCode: 500, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ error: { code: "internal_error", message: "internal error" } }), isBase64Encoded: false };
    }
  };
}

export async function startServer(
  port = Number(process.env.PORT ?? 4400),
  host = (process.env.HOST ?? "").trim() || "127.0.0.1",
): Promise<{ close: () => Promise<void> }> {
  const config = loadConfig();
  const database = new Database(config.databaseUrl);
  await applySchema(database);
  const app = createApp({ config, store: new PostgresStore(database) });

  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "localhost"}`);
    const chunks: Buffer[] = [];
    // A hung-up client must also stop the upstream LLM call, otherwise the
    // gateway keeps generating tokens nobody receives.
    const disconnect = new AbortController();
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) disconnect.abort();
    });
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const request: HttpRequest = {
        method: (incoming.method ?? "GET").toUpperCase(),
        path: normalizePath(url.pathname),
        query: url.searchParams,
        headers: Object.fromEntries(Object.entries(incoming.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        body: Buffer.concat(chunks),
        ip: incoming.socket.remoteAddress ?? null,
        signal: disconnect.signal,
      };
      void app(request).then(async (response) => {
        outgoing.writeHead(response.status, response.headers);
        if (!response.stream) {
          outgoing.end(response.body);
          return;
        }
        try {
          for await (const chunk of response.stream) {
            if (outgoing.destroyed) break;
            outgoing.write(chunk);
          }
          outgoing.end();
        } catch (error) {
          // The status line is already sent, so a mid-stream failure can only
          // tear the connection down; the client sees a truncated reply.
          console.error("accounts stream failed", error instanceof Error ? error.message : error);
          outgoing.destroy();
        }
      }).catch((error: unknown) => {
        console.error("accounts local server failed", error);
        outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        outgoing.end(JSON.stringify({ error: { code: "internal_error", message: "internal error" } }));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.log(`accounts service listening on http://${host}:${port}`);
  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await database.close();
    },
  };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await startServer();
}
