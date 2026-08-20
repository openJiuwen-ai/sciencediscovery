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
 * Bootstrap credentials for the single-file distribution.
 *
 * `serve` has to know the access token before it spawns anything, so it can
 * hand it to the API and print it once the stack is up. The resolution chain is
 * "explicit environment variable, then the value this installation already
 * stored, then a freshly generated one" — the product carries no fixed default
 * credential.
 *
 * This duplicates `services/api/src/http/bootstrap-tokens.ts` on purpose: the
 * release script builds only `@sciencediscovery/launcher` before esbuild bundles
 * it into the executable, so a workspace dependency here would break packaging.
 * The file layout (one token per file under `<dataDir>/secrets/`) is the real
 * contract.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type BootstrapTokenSource = "environment" | "generated" | "stored";

export interface ResolvedBootstrapToken {
  source: BootstrapTokenSource;
  token: string;
}

export const BOOTSTRAP_SECRETS_DIRECTORY = "secrets";
export const AUTH_TOKEN_FILE = "auth-token";

const TOKEN_BYTES = 32;

export function bootstrapTokenPath(dataDir: string, fileName: string): string {
  return join(dataDir, BOOTSTRAP_SECRETS_DIRECTORY, fileName);
}

function readStoredToken(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function resolveBootstrapToken(
  dataDir: string,
  fileName: string,
  explicit?: string,
): ResolvedBootstrapToken {
  const configured = explicit?.trim();
  if (configured) return { source: "environment", token: configured };

  const path = bootstrapTokenPath(dataDir, fileName);
  const stored = readStoredToken(path);
  if (stored) return { source: "stored", token: stored };

  mkdirSync(join(dataDir, BOOTSTRAP_SECRETS_DIRECTORY), { mode: 0o700, recursive: true });
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  try {
    writeFileSync(path, `${token}\n`, { flag: "wx", mode: 0o600 });
    return { source: "generated", token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = readStoredToken(path);
    if (winner) return { source: "stored", token: winner };
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    return { source: "generated", token };
  }
}

/**
 * The credentials `serve` resolves once and shares with every child process.
 * Only the browser-facing access token remains: the control-plane-to-gateway
 * token existed for an HTTP service that no longer runs.
 */
export interface ServeCredentials {
  authToken: ResolvedBootstrapToken;
}

export function resolveServeCredentials(dataDir: string, env: NodeJS.ProcessEnv): ServeCredentials {
  return {
    authToken: resolveBootstrapToken(dataDir, AUTH_TOKEN_FILE, env.SCIENCE_AGENT_AUTH_TOKEN),
  };
}

/**
 * Ready-banner lines for the token the user pastes into the Web UI. A managed
 * token is printed in full because nothing else reveals it; an operator-supplied
 * one is only named, so `serve` never echoes a secret they already hold.
 */
export function accessTokenBanner(dataDir: string, credentials: ServeCredentials): string[] {
  const { source, token } = credentials.authToken;
  if (source === "environment") {
    return ["  Access token: from SCIENCE_AGENT_AUTH_TOKEN (not printed)."];
  }
  return [
    `  Access token (${source === "generated" ? "generated on first start" : "restored from local storage"}): ${token}`,
    `  Stored in ${bootstrapTokenPath(dataDir, AUTH_TOKEN_FILE)}; paste it into the Web UI when asked.`,
  ];
}
