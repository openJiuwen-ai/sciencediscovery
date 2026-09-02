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

import { generateKeyPairSync, randomBytes } from "node:crypto";

import ssh2 from "ssh2";

const { utils } = ssh2;

/**
 * Key material the product holds for one machine.
 *
 * Asking a user to paste a private key into a browser is the wrong shape: the
 * secret ends up in form state, in screenshots and in whatever the page logs.
 * Instead the product either reads a key file the user already has, or makes a
 * key pair itself — and in both cases only the public half is ever handed back,
 * for the user to install on the remote machine.
 */
export interface SshKeyPair {
  /** OpenSSH private key material, for this product's own storage only. */
  privateKey: string;
  /** One-line OpenSSH public key, safe to display and to copy into authorized_keys. */
  publicKey: string;
}

function sshString(value: Buffer | string): Buffer {
  const body = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

function pemBlock(label: string, body: Buffer): string {
  const base64 = body.toString("base64").replace(/(.{70})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${base64}${base64.endsWith("\n") ? "" : "\n"}-----END ${label}-----\n`;
}

/**
 * Assemble an unencrypted OpenSSH private key.
 *
 * Node can only export Ed25519 as PKCS#8, which the SSH client cannot read, so
 * the OpenSSH container is written here. The layout is the documented one:
 * a magic string, the cipher/KDF names left as `none`, the public key, and a
 * section whose two check integers match to prove it decrypted correctly.
 */
function openSshPrivateKey(seed: Buffer, publicKey: Buffer, comment: string): string {
  const keyType = "ssh-ed25519";
  const publicBlob = Buffer.concat([sshString(keyType), sshString(publicKey)]);
  const check = randomBytes(4);
  const unpadded = Buffer.concat([
    check,
    check,
    sshString(keyType),
    sshString(publicKey),
    sshString(Buffer.concat([seed, publicKey])),
    sshString(comment),
  ]);
  // The private section is padded to the cipher block size with 1, 2, 3, …
  const padding = Buffer.from(
    Array.from({ length: (8 - (unpadded.length % 8)) % 8 }, (_unused, index) => index + 1),
  );
  return pemBlock("OPENSSH PRIVATE KEY", Buffer.concat([
    Buffer.from("openssh-key-v1\0", "utf8"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    Buffer.from([0, 0, 0, 1]),
    sshString(publicBlob),
    sshString(Buffer.concat([unpadded, padding])),
  ]));
}

/** Generate a key pair for one machine. Ed25519: small, fast, and universally accepted. */
export function generateSshKeyPair(comment: string): SshKeyPair {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { d?: string; x?: string };
  if (!jwk.d || !jwk.x) throw new Error("Could not generate an Ed25519 key pair");
  const seed = Buffer.from(jwk.d, "base64url");
  const publicKey = Buffer.from(jwk.x, "base64url");
  const material = openSshPrivateKey(seed, publicKey, comment);
  return { privateKey: material, publicKey: openSshPublicKey(material, comment) ?? "" };
}

/**
 * The one-line public key for stored private key material, so a key the user
 * pointed at can be displayed and installed exactly like a generated one.
 * Returns `undefined` when the material cannot be read as a key.
 */
export function openSshPublicKey(privateKey: string, comment?: string): string | undefined {
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) return undefined;
  const line = `${parsed.type} ${parsed.getPublicSSH().toString("base64")}`;
  return comment?.trim() ? `${line} ${comment.trim()}` : line;
}
