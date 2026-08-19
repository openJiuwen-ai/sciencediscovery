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
 * Bootstrap credentials for the local control plane.
 *
 * The product ships with no fixed default token. When an operator does not set
 * the documented environment variable, the token is generated once from a CSPRNG
 * and persisted under `<dataDir>/secrets/`, so a normal restart keeps working
 * and every process in the stack agrees on the same value.
 *
 * The file layout is a cross-language contract: the Python Gateway
 * (`science_agent_gateway.bootstrap_tokens`) and the single-binary launcher
 * (`services/launcher/src/bootstrap-tokens.ts`) implement the same resolution
 * chain against the same paths. One token per file keeps creation a single
 * atomic `O_CREAT|O_EXCL` call, so two services starting at once cannot end up
 * with two different tokens — the loser of the race simply reads the winner's
 * value back.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Where the token came from, so startup output can be honest about it. */
export type BootstrapTokenSource = "environment" | "generated" | "stored";

export interface ResolvedBootstrapToken {
  source: BootstrapTokenSource;
  token: string;
}

/** Directory under the data dir that holds the generated credentials. */
export const BOOTSTRAP_SECRETS_DIRECTORY = "secrets";
/** Browser-to-control-plane bearer token (`SCIENCE_AGENT_AUTH_TOKEN`). */
export const AUTH_TOKEN_FILE = "auth-token";

/** 32 random bytes; base64url keeps it copy-pasteable into a header or a form. */
const TOKEN_BYTES = 32;

export function bootstrapTokenPath(dataDir: string, fileName: string): string {
  return resolve(dataDir, BOOTSTRAP_SECRETS_DIRECTORY, fileName);
}

function readStoredToken(path: string): string | undefined {
  try {
    const token = readFileSync(path, "utf8").trim();
    return token || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Resolve one credential: an explicit operator value wins, then a previously
 * generated one, and only a first-ever start generates and persists a new token.
 */
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

  mkdirSync(resolve(dataDir, BOOTSTRAP_SECRETS_DIRECTORY), { mode: 0o700, recursive: true });
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  try {
    writeFileSync(path, `${token}\n`, { flag: "wx", mode: 0o600 });
    return { source: "generated", token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Another service in the stack created it first; its value is authoritative.
    const winner = readStoredToken(path);
    if (winner) return { source: "stored", token: winner };
    // The file exists but is empty or blank: replace it rather than hand out "".
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    return { source: "generated", token };
  }
}

/**
 * Startup lines describing the bearer token the Web UI needs. A token this
 * installation generated is printed in full, because nothing else tells the
 * user what it is. A token the operator supplied through
 * `SCIENCE_AGENT_AUTH_TOKEN` is only named, never echoed: they already have it,
 * and console output can outlive the process in shared terminals and CI logs.
 */
export function accessTokenBanner(config: {
  authToken: string;
  authTokenSource?: BootstrapTokenSource;
  dataDir: string;
}): string[] {
  if (config.authTokenSource === "environment") {
    return ["Local API token comes from SCIENCE_AGENT_AUTH_TOKEN; its value is not printed."];
  }
  const origin = config.authTokenSource === "stored"
    ? "restored from local storage"
    : "generated on first start";
  return [
    `Local API token (${origin}): ${config.authToken}`,
    `  Stored in ${bootstrapTokenPath(config.dataDir, AUTH_TOKEN_FILE)}; paste it into the Web UI when asked.`,
  ];
}
