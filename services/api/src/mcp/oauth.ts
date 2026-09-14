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

import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { auth, extractWWWAuthenticateParams, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CustomMcpServerConfig, McpAuthorizationStart, McpAuthorizationStatus } from "@sciencediscovery/schema";
import { decryptSecretValue, encryptSecretValue } from "../store/secrets.js";

export const MCP_OAUTH_CALLBACK = "/api/mcp/oauth/callback";
const AUTH_REQUIRED = "MCP OAuth login required. Open MCP server settings to authorize this server.";
const TTL = 10 * 60_000;
type Challenge = ReturnType<typeof extractWWWAuthenticateParams>;
type Credentials = {
  signature: string;
  redirectUrl: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
  discovery?: OAuthDiscoveryState;
};
type Pending = {
  id: string; state: string; expiresAt: number; verifier?: string; authorizationUrl?: string;
  credentials: Credentials; generation: number;
};

export function validateOAuthUrl(value: string | URL): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.hash) {
    throw new Error("OAuth requires HTTPS (HTTP is allowed only on localhost)");
  }
  return url;
}

function signature(config: CustomMcpServerConfig): string {
  return createHash("sha256").update(JSON.stringify([config.transport, config.url, config.authMode, config.oauth])).digest("hex");
}

// SDK discovery and token exchange never follow redirects with client credentials.
const oauthFetch: FetchLike = (input, init) => {
  validateOAuthUrl(input instanceof Request ? input.url : input.toString());
  return fetch(input, { ...init, redirect: "error", signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
};

export class McpOAuthManager {
  private saved: Record<string, Credentials> = {};
  private readonly pending = new Map<string, Pending>();
  private readonly generations = new Map<string, number>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly errors = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private key?: Buffer;
  private readonly path: string;

  constructor(dataDir: string, private readonly config: (id: string) => CustomMcpServerConfig | undefined) {
    this.path = resolve(dataDir, "mcp-oauth.enc");
  }

  async load(key: Buffer): Promise<void> {
    this.key = key;
    try { this.saved = JSON.parse(decryptSecretValue(key, "mcp-oauth", await readFile(this.path, "utf8"))) as Record<string, Credentials>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const id of Object.keys(this.saved)) if (!this.current(id)) delete this.saved[id];
  }

  private persist(): Promise<void> {
    const operation = this.queue.then(async () => {
      if (!this.key) throw new Error("MCP OAuth storage is not initialized");
      await writeFile(`${this.path}.tmp`, encryptSecretValue(this.key, "mcp-oauth", JSON.stringify(this.saved)), { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private current(id: string): Credentials | undefined {
    const config = this.config(id);
    const entry = this.saved[id];
    return config?.authMode === "oauth" && entry?.signature === signature(config) ? entry : undefined;
  }

  private activePending(id: string): Pending | undefined {
    const pending = this.pending.get(id);
    if (pending && pending.expiresAt <= Date.now()) {
      this.pending.delete(id);
      this.errors.set(id, "OAuth login expired. Please try again.");
      return undefined;
    }
    return pending;
  }

  status(id: string): McpAuthorizationStatus | undefined {
    if (this.config(id)?.authMode !== "oauth") return undefined;
    const pending = this.activePending(id);
    const entry = this.current(id);
    const error = this.errors.get(id);
    return {
      state: pending ? "authorizing" : error || !entry?.tokens ? "required" : entry.expiresAt && entry.expiresAt <= Date.now() ? "expired" : "authorized",
      ...(entry?.expiresAt ? { expiresAt: new Date(entry.expiresAt).toISOString() } : {}),
      ...(entry?.tokens?.scope ? { scope: entry.tokens.scope } : {}),
      ...(error ? { error } : {}),
    };
  }

  cancel(id: string): void {
    this.pending.delete(id);
  }

  async clear(id: string): Promise<void> {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.pending.delete(id);
    this.challenges.delete(id);
    this.errors.delete(id);
    delete this.saved[id];
    await this.persist();
  }

  private provider(id: string, credentials: Credentials, generation: number, pending?: Pending): OAuthClientProvider {
    const config = this.config(id)!;
    const assertCurrent = () => {
      if (this.generations.get(id) !== generation || !this.config(id) || signature(this.config(id)!) !== credentials.signature
        || (pending && this.activePending(id) !== pending)) throw new Error("OAuth authorization was cancelled or the configuration changed");
    };
    const save = async () => { assertCurrent(); if (!pending) { this.saved[id] = credentials; await this.persist(); } };
    return {
      redirectUrl: credentials.redirectUrl,
      ...(config.oauth?.clientMetadataUrl ? { clientMetadataUrl: config.oauth.clientMetadataUrl } : {}),
      clientMetadata: {
        client_name: "ScienceDiscovery", redirect_uris: [credentials.redirectUrl],
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
        token_endpoint_auth_method: config.oauth?.clientSecret ? "client_secret_post" : "none",
        ...(config.oauth?.scope ? { scope: config.oauth.scope } : {}),
      },
      state: () => { assertCurrent(); if (!pending) throw new Error(AUTH_REQUIRED); return pending.state; },
      clientInformation: () => credentials.client,
      saveClientInformation: async (client) => { assertCurrent(); credentials.client = client; await save(); },
      tokens: () => pending ? undefined : credentials.tokens,
      saveTokens: async (tokens) => {
        assertCurrent();
        if (tokens.token_type.toLowerCase() !== "bearer") throw new Error("Unsupported OAuth token type");
        credentials.tokens = { ...tokens, ...(!pending && !tokens.refresh_token && credentials.tokens?.refresh_token ? { refresh_token: credentials.tokens.refresh_token } : {}) };
        credentials.expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
        await save();
      },
      redirectToAuthorization: async (url) => { assertCurrent(); if (!pending) throw new Error(AUTH_REQUIRED); validateOAuthUrl(url); pending.authorizationUrl = url.toString(); },
      saveCodeVerifier: async (verifier) => { assertCurrent(); if (!pending) throw new Error(AUTH_REQUIRED); pending.verifier = verifier; },
      codeVerifier: () => { assertCurrent(); if (!pending?.verifier) throw new Error("Missing OAuth verifier"); return pending.verifier; },
      discoveryState: () => credentials.discovery,
      saveDiscoveryState: async (discovery) => { assertCurrent(); credentials.discovery = discovery; await save(); },
      invalidateCredentials: async (scope) => {
        assertCurrent();
        if (scope === "all" || scope === "tokens") { delete credentials.tokens; delete credentials.expiresAt; }
        if (scope === "all" || scope === "client") delete credentials.client;
        if (scope === "all" || scope === "discovery") delete credentials.discovery;
        if ((scope === "all" || scope === "verifier") && pending) delete pending.verifier;
        await save();
      },
    };
  }

  async begin(id: string, redirectUrl: string): Promise<McpAuthorizationStart> {
    const config = this.config(id);
    if (!config || config.transport === "stdio" || config.authMode !== "oauth") throw new Error("OAuth is not configured for this MCP server");
    const callback = validateOAuthUrl(redirectUrl);
    if (callback.pathname !== MCP_OAUTH_CALLBACK || callback.search) throw new Error("Invalid OAuth callback URL");
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    const previous = this.current(id);
    const credentials: Credentials = {
      signature: signature(config), redirectUrl: callback.toString(),
      ...(previous?.redirectUrl === callback.toString() && previous.client ? { client: structuredClone(previous.client) } : {}),
      ...(config.oauth?.clientId ? { client: { client_id: config.oauth.clientId, ...(config.oauth.clientSecret ? { client_secret: config.oauth.clientSecret } : {}) } } : {}),
    };
    const pending: Pending = { id, credentials, generation, state: randomBytes(32).toString("hex"), expiresAt: Date.now() + TTL };
    this.pending.set(id, pending);
    this.errors.delete(id);
    try {
      let challenge = this.challenges.get(id);
      if (!challenge) {
        const headers = Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, value.startsWith("$") ? process.env[value.slice(1)] ?? "" : value]));
        const response = await oauthFetch(config.url, { headers: { ...headers, Accept: "application/json, text/event-stream" } });
        challenge = extractWWWAuthenticateParams(response);
        await response.body?.cancel();
      }
      await auth(this.provider(id, credentials, generation, pending), { serverUrl: config.url, ...challenge, fetchFn: oauthFetch });
      if (!pending.authorizationUrl) throw new Error("OAuth server did not return a login URL");
      return { authorizationUrl: pending.authorizationUrl, expiresAt: new Date(pending.expiresAt).toISOString() };
    } catch {
      if (this.pending.get(id) === pending) { this.pending.delete(id); this.errors.set(id, "OAuth discovery failed. Check the server URL and registered client configuration."); }
      throw new Error("OAuth login could not start. Check server metadata, HTTPS, and client registration (Client ID may be required).");
    }
  }

  async complete(state: string, code: string | null, denied: boolean): Promise<string> {
    const pending = [...this.pending.values()].find((item) => item.state === state && state.length === 64);
    if (!pending || this.activePending(pending.id) !== pending || !pending.verifier) throw new Error("Invalid or expired OAuth state");
    // Consume the state before any network I/O; the provider still owns this pending attempt.
    pending.state = "";
    try {
      if (denied || !code || code.length > 16_384) throw new Error("Authorization denied");
      const config = this.config(pending.id);
      if (!config) throw new Error("Server removed");
      await auth(this.provider(pending.id, pending.credentials, pending.generation, pending), { serverUrl: config.url, authorizationCode: code, fetchFn: oauthFetch });
      if (this.activePending(pending.id) !== pending || this.generations.get(pending.id) !== pending.generation) throw new Error("OAuth authorization was cancelled");
      this.saved[pending.id] = pending.credentials;
      await this.persist();
      this.errors.delete(pending.id);
      this.challenges.delete(pending.id);
      return pending.id;
    } catch {
      if (this.pending.get(pending.id) === pending) this.errors.set(pending.id, "OAuth authorization failed or was denied. Please sign in again.");
      throw new Error("OAuth authorization failed or was denied. Return to MCP settings and try again.");
    } finally { if (this.pending.get(pending.id) === pending) this.pending.delete(pending.id); }
  }

  async prepare(id: string, rejectedToken?: string): Promise<void> {
    if (this.config(id)?.authMode !== "oauth") return;
    const credentials = this.current(id);
    if (!credentials?.tokens || this.errors.has(id)) throw new Error(AUTH_REQUIRED);
    if (rejectedToken && credentials.tokens.access_token !== rejectedToken) return;
    if (!rejectedToken && (!credentials.expiresAt || credentials.expiresAt > Date.now() + 5_000)) return;
    const existing = this.refreshing.get(id);
    if (existing) return existing;
    const generation = this.generations.get(id) ?? 0;
    this.generations.set(id, generation);
    const operation = (async () => {
      try {
        if (!credentials.tokens?.refresh_token) throw new Error(AUTH_REQUIRED);
        await auth(this.provider(id, structuredClone(credentials), generation), { serverUrl: this.config(id)!.url, ...this.challenges.get(id), fetchFn: oauthFetch });
      } catch {
        if (this.generations.get(id) === generation) this.errors.set(id, AUTH_REQUIRED);
        throw new Error(AUTH_REQUIRED);
      }
    })();
    this.refreshing.set(id, operation);
    try { await operation; } finally { if (this.refreshing.get(id) === operation) this.refreshing.delete(id); }
  }

  fetchFor(id: string): FetchLike | undefined {
    const config = this.config(id);
    if (config?.authMode !== "oauth") return undefined;
    const origin = new URL(config.url).origin;
    const expected = signature(config);
    return async (input, init) => {
      const target = validateOAuthUrl(input instanceof Request ? input.url : input.toString());
      if (target.origin !== origin || !this.config(id) || signature(this.config(id)!) !== expected) throw new Error("OAuth request does not match the configured MCP server");
      await this.prepare(id);
      const token = this.current(id)?.tokens?.access_token;
      if (!token) throw new Error(AUTH_REQUIRED);
      const send = (accessToken: string) => {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.set("Authorization", `Bearer ${accessToken}`);
        return fetch(input, { ...init, headers, redirect: "error" });
      };
      let response = await send(token);
      if (response.status === 401 || response.status === 403) {
        const challenge = extractWWWAuthenticateParams(response);
        this.challenges.set(id, challenge);
        if (response.status === 403) {
          if (challenge.error === "insufficient_scope") { this.errors.set(id, "Additional OAuth consent is required. Please sign in again."); await response.body?.cancel(); throw new Error(AUTH_REQUIRED); }
          return response;
        }
        await response.body?.cancel();
        await this.prepare(id, token);
        response = await send(this.current(id)!.tokens!.access_token);
        if (response.status === 401) { this.errors.set(id, AUTH_REQUIRED); await response.body?.cancel(); throw new Error(AUTH_REQUIRED); }
      }
      return response;
    };
  }
}
