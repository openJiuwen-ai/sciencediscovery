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
 * The cryptography this service needs, with no third-party dependency.
 *
 * - HS256 JWTs for the one-time ticket, the access token and the admin
 *   challenge token. Signatures are compared in constant time.
 * - scrypt password hashes whose parameters travel with the hash, so raising
 *   the cost later does not invalidate stored passwords.
 * - Opaque refresh tokens: 256 random bits, stored only as a SHA-256 digest.
 */

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** Work factors stored alongside every hash. One object keeps the numbers
 *  written into the record and the numbers used to verify it in lockstep. */
const SCRYPT_COST = Object.freeze({ N: 16_384, r: 8, p: 1 });
const SCRYPT_MAXMEM_BYTES = 64 * 1024 * 1024;

function derivePasswordKey(secret: string, salt: Buffer, length: number, cost: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, length, { ...cost, maxmem: SCRYPT_MAXMEM_BYTES }, (failure, derived) => {
      if (failure) reject(failure);
      else resolve(derived);
    });
  });
}

export type JwtClaims = Record<string, unknown>;

export function signJwt(claims: JwtClaims, secret: string, ttlSeconds: number, nowMs = Date.now()): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url");
  const payload = Buffer.from(JSON.stringify({ ...claims, iat: issuedAt, exp: issuedAt + ttlSeconds }), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * Returns the claims of a token this service signed and that has not expired.
 * Any structural, signature or expiry problem returns `undefined`: callers act
 * on valid tokens only, so there is no error shape to mishandle.
 */
export function verifyJwt<T extends JwtClaims = JwtClaims>(token: string, secret: string, nowMs = Date.now()): T | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (claims === null || typeof claims !== "object") return undefined;
  const exp = (claims as JwtClaims).exp;
  if (typeof exp !== "number" || exp * 1000 <= nowMs) return undefined;
  return claims as T;
}

/** `scrypt$N$r$p$salt$hash`, all base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derivePasswordKey(password, salt, 32, SCRYPT_COST);
  return ["scrypt", SCRYPT_COST.N, SCRYPT_COST.r, SCRYPT_COST.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts as [string, string, string, string, string, string];
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
  const salt = Buffer.from(rawSalt, "base64url");
  const expected = Buffer.from(rawHash, "base64url");
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = await derivePasswordKey(password, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 256 random bits as unpadded base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}
