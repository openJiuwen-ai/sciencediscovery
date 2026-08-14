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

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import type { CasObjectRef } from "@science-agent/schema";

export interface ContentStore {
  hash(content: string | Buffer): string;
  has(hash: string): Promise<boolean>;
  put(content: string | Buffer): Promise<CasObjectRef>;
  putFile(path: string): Promise<CasObjectRef>;
  read(hash: string): Promise<Buffer>;
  verify(hash: string): Promise<boolean>;
}

export function sha256(content: string | Buffer): string {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Append-only SHA-256 content-addressed storage rooted under data/cas/sha256. */
export class CasStore implements ContentStore {
  constructor(private readonly dataDir: string) {}

  private objectPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid CAS hash");
    return resolve(this.dataDir, "cas", "sha256", hash.slice(0, 2), hash);
  }

  hash(content: string | Buffer): string {
    return sha256(content);
  }

  async put(content: string | Buffer): Promise<CasObjectRef> {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const hash = this.hash(bytes);
    const path = this.objectPath(hash);
    if (await this.has(hash)) return { hash, size: bytes.length };

    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, bytes);
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return { hash, size: bytes.length };
  }

  async putFile(sourcePath: string): Promise<CasObjectRef> {
    const temporaryDirectory = resolve(this.dataDir, "cas", "sha256", ".tmp");
    await mkdir(temporaryDirectory, { recursive: true });
    const temporaryPath = resolve(temporaryDirectory, `${process.pid}.${randomUUID()}.tmp`);
    const hash = createHash("sha256");
    let size = 0;
    try {
      await pipeline(
        createReadStream(sourcePath),
        async function* (source) {
          for await (const chunk of source) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            hash.update(bytes);
            size += bytes.length;
            yield bytes;
          }
        },
        createWriteStream(temporaryPath, { flags: "wx" }),
      );
      const digest = hash.digest("hex");
      const destination = this.objectPath(digest);
      if (await this.has(digest)) {
        await rm(temporaryPath, { force: true });
      } else {
        await mkdir(dirname(destination), { recursive: true });
        await rename(temporaryPath, destination);
      }
      return { hash: digest, size };
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async has(hash: string): Promise<boolean> {
    try {
      await stat(this.objectPath(hash));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async verify(hash: string): Promise<boolean> {
    try {
      return this.hash(await this.read(hash)) === hash;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async read(hash: string): Promise<Buffer> {
    return await readFile(this.objectPath(hash));
  }
}
