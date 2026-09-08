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

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { CasObjectRef } from "@sciencediscovery/schema";
import { VersionStore, type ObjectRef, type Pool } from "./versioning.js";

export * from "./versioning.js";
export * from "./workspace-lease.js";
export * from "./workspace-snapshot.js";

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

/** Legacy hash facade: dual-pool writes, compatible reads of the old mixed layout. */
export class CasStore implements ContentStore {
  constructor(private readonly dataDir: string, private readonly pool: Pool = "agent-state") {}

  private objectPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid CAS hash");
    return resolve(this.dataDir, "versioning", this.pool, "blobs", "sha256", hash);
  }

  hash(content: string | Buffer): string {
    return sha256(content);
  }

  async put(content: string | Buffer): Promise<CasObjectRef> {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const hash = this.hash(bytes);
    await new VersionStore(this.dataDir).put(this.pool, bytes);
    return { hash, size: bytes.length };
  }

  async putFile(sourcePath: string): Promise<CasObjectRef> {
    const ref = await new VersionStore(this.dataDir).putFile(this.pool, sourcePath);
    return { hash: ref.digest.slice(7), size: ref.size };
  }

  async has(hash: string): Promise<boolean> {
    try {
      await this.read(hash);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async verify(hash: string): Promise<boolean> {
    this.objectPath(hash);
    try {
      return this.hash(await this.read(hash)) === hash;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as Error).message === "CAS integrity failure") return false;
      throw error;
    }
  }

  async read(hash: string): Promise<Buffer> {
    for (const path of this.readPaths(hash)) {
      try {
        const bytes = await readFile(path);
        if (sha256(bytes) !== hash) throw new Error("CAS integrity failure");
        return bytes;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw Object.assign(new Error("CAS object not found"), { code: "ENOENT" });
  }

  /** Promote a legacy reference into a typed pool without buffering large historical files. */
  async retain<P extends Pool>(reference: CasObjectRef, pool: P): Promise<ObjectRef<P>> {
    for (const path of this.readPaths(reference.hash)) {
      try {
        const target = await new VersionStore(this.dataDir).putFile(pool, path);
        if (target.digest !== `sha256:${reference.hash}` || target.size !== reference.size) throw new Error("Legacy reference integrity failure");
        return target;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw Object.assign(new Error("CAS object not found"), { code: "ENOENT" });
  }

  private readPaths(hash: string): string[] {
    const current = this.objectPath(hash); // validates before resolving any path
    const other = this.pool === "data" ? "agent-state" : "data";
    return [current, resolve(this.dataDir, "versioning", other, "blobs", "sha256", hash),
      resolve(this.dataDir, "cas", "sha256", hash.slice(0, 2), hash)];
  }
}
