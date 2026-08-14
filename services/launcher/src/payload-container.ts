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
 * Container format that turns one ELF executable into the whole product.
 *
 * The release binary is `[launcher ELF][zstd(tar) payload][footer]`. Trailing
 * bytes after an ELF image are ignored by the loader, so the file stays a
 * normal executable for `file`, `readelf` and exec(2) while carrying the
 * runtime payload the launcher unpacks on first `serve`.
 */
import { open } from "node:fs/promises";

export const PAYLOAD_MAGIC = Buffer.from("SCIENCEAGENTPL01", "ascii");
/** magic(16) + payloadOffset(8) + payloadSize(8) + payloadId(16). */
export const PAYLOAD_FOOTER_BYTES = 48;
const PAYLOAD_ID_BYTES = 16;

export interface PayloadLocator {
  /** Byte offset of the compressed payload inside the container file. */
  offset: number;
  /** Compressed payload length in bytes. */
  size: number;
  /** Hex payload digest prefix; names the extraction cache directory. */
  id: string;
}

export function encodePayloadFooter(locator: PayloadLocator): Buffer {
  const identifier = Buffer.from(locator.id, "hex");
  if (identifier.length !== PAYLOAD_ID_BYTES) {
    throw new Error(`Payload id must be ${PAYLOAD_ID_BYTES} hex-encoded bytes`);
  }
  const footer = Buffer.alloc(PAYLOAD_FOOTER_BYTES);
  PAYLOAD_MAGIC.copy(footer, 0);
  footer.writeBigUInt64LE(BigInt(locator.offset), 16);
  footer.writeBigUInt64LE(BigInt(locator.size), 24);
  identifier.copy(footer, 32);
  return footer;
}

export function decodePayloadFooter(footer: Buffer): PayloadLocator | undefined {
  if (footer.length !== PAYLOAD_FOOTER_BYTES) return undefined;
  if (!footer.subarray(0, PAYLOAD_MAGIC.length).equals(PAYLOAD_MAGIC)) return undefined;
  const offset = Number(footer.readBigUInt64LE(16));
  const size = Number(footer.readBigUInt64LE(24));
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size <= 0) return undefined;
  return { id: footer.subarray(32, 32 + PAYLOAD_ID_BYTES).toString("hex"), offset, size };
}

/**
 * Read the payload locator from a container file. Returns undefined for a
 * plain executable with no payload appended, which is how `serve` detects a
 * development run against an unbundled checkout.
 */
export async function readPayloadLocator(containerPath: string): Promise<PayloadLocator | undefined> {
  const handle = await open(containerPath, "r");
  try {
    const { size: fileSize } = await handle.stat();
    if (fileSize < PAYLOAD_FOOTER_BYTES) return undefined;
    const footer = Buffer.alloc(PAYLOAD_FOOTER_BYTES);
    await handle.read(footer, 0, PAYLOAD_FOOTER_BYTES, fileSize - PAYLOAD_FOOTER_BYTES);
    const locator = decodePayloadFooter(footer);
    if (!locator) return undefined;
    if (locator.offset + locator.size !== fileSize - PAYLOAD_FOOTER_BYTES) {
      throw new Error(`The embedded payload in ${containerPath} is truncated or corrupt.`);
    }
    return locator;
  } finally {
    await handle.close();
  }
}
