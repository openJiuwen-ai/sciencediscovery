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
 * A request/response pair that both entry points can produce.
 *
 * `node:http` fills it from a real socket; the FunctionGraph adapter fills it
 * from the event object. Nothing below this file knows which one happened, so
 * every route behaves identically in local development and in the cloud.
 */

export interface HttpRequest {
  method: string;
  /** Decoded path, always starting with `/`, no trailing slash except the root. */
  path: string;
  query: URLSearchParams;
  /** Header names lowercased. */
  headers: Record<string, string>;
  body: Buffer;
  ip: string | null;
  /**
   * Aborts when the caller hangs up. Only the local server can supply it; the
   * streaming proxy forwards it upstream so a closed tab stops billing too.
   */
  signal?: AbortSignal | undefined;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
  /**
   * When present, the local server writes these chunks as they arrive instead
   * of `body`. That is how an SSE reply reaches the client token by token.
   */
  stream?: AsyncIterable<Uint8Array> | undefined;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }
}

export const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } as const;

export function json(status: number, payload: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(payload) };
}

export function redirect(location: string, headers: Record<string, string> = {}, status = 302): HttpResponse {
  return { status, headers: { location, "cache-control": "no-store", ...headers }, body: "" };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim() || undefined;
  }
  return undefined;
}

export function serializeCookie(name: string, value: string, options: { maxAge?: number; domain?: string; secure?: boolean; httpOnly?: boolean } = {}): string {
  const parts = [`${name}=${value}`, "Path=/", "SameSite=Lax"];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

export function readJsonBody(request: HttpRequest): Record<string, unknown> {
  if (request.body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "invalid_json", "body must be an object");
  return parsed as Record<string, unknown>;
}

export function readString(source: Record<string, unknown>, key: string, options: { maxLength?: number } = {}): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "invalid_field", `${key} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (options.maxLength !== undefined && trimmed.length > options.maxLength) throw new HttpError(400, "invalid_field", `${key} is too long`);
  return trimmed;
}

export function readNumber(source: Record<string, unknown>, key: string, options: { min?: number; max?: number } = {}): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new HttpError(400, "invalid_field", `${key} must be a number`);
  if (options.min !== undefined && parsed < options.min) throw new HttpError(400, "invalid_field", `${key} is below the minimum`);
  if (options.max !== undefined && parsed > options.max) throw new HttpError(400, "invalid_field", `${key} is above the maximum`);
  return parsed;
}

export type RouteHandler = (request: HttpRequest, params: Record<string, string>) => Promise<HttpResponse>;

interface CompiledRoute {
  method: string;
  pattern: string;
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: CompiledRoute[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    const keys: string[] = [];
    const source = pattern
      .split("/")
      .map((segment) => {
        if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        keys.push(segment.slice(1));
        return "([^/]+)";
      })
      .join("/");
    this.routes.push({ method: method.toUpperCase(), pattern, regex: new RegExp(`^${source}/?$`, "u"), keys, handler });
    return this;
  }

  /** Returns the handler and its path parameters, or `undefined` for no match. */
  match(method: string, path: string): { handler: RouteHandler; params: Record<string, string> } | undefined {
    const wanted = method.toUpperCase();
    for (const route of this.routes) {
      if (route.method !== wanted) continue;
      const match = route.regex.exec(path);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1] ?? "");
      });
      return { handler: route.handler, params };
    }
    return undefined;
  }
}
