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

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { isAbsolute, resolve } from "node:path";

import type { SshConfigHostImport } from "@sciencediscovery/schema";

/**
 * Read one `Host` block out of the user's SSH configuration so a machine they
 * already use can be registered without retyping it.
 *
 * The product no longer connects through that configuration — it speaks SSH
 * itself with its own credentials — so this is strictly a convenience: the
 * values are copied into the machine record, and from then on the product's
 * copy is what is used.
 */
export async function readSshConfigHost(configPath: string, aliasValue: string): Promise<SshConfigHostImport> {
  const alias = aliasValue.trim();
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(alias)) throw new Error("That is not a valid SSH config host name");
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(`Could not read the SSH configuration at ${configPath}: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}`);
  }
  let inBlock = false;
  const entry: SshConfigHostImport = { alias, identityKeyReadable: false };
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [keyword, ...parts] = line.split(/\s+/);
    const directive = keyword?.toLocaleLowerCase();
    if (directive === "host") {
      // Only an exact name is imported: a pattern block such as `Host *` says
      // nothing definite about this machine.
      inBlock = parts.includes(alias);
      continue;
    }
    if (!inBlock || !parts.length) continue;
    if (directive === "hostname") entry.hostName = parts[0];
    else if (directive === "user") entry.username = parts[0];
    else if (directive === "port") {
      const port = Number(parts[0]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) entry.port = port;
    } else if (directive === "identityfile" && !entry.identityFile) {
      entry.identityFile = parts[0]?.startsWith("~/")
        ? expandPrivateKeyPath(parts[0])
        : parts[0] && isAbsolute(parts[0]) ? parts[0] : resolve(configPath, "..", parts[0] ?? "");
    }
  }
  if (!entry.hostName && !entry.username && !entry.port && !entry.identityFile) {
    throw new Error(`The SSH configuration has no Host entry named ${alias}`);
  }
  if (entry.identityFile) entry.identityKeyReadable = await readablePrivateKey(entry.identityFile) !== undefined;
  return entry;
}

/**
 * Every `Host` entry the user could import, so the settings page can offer a
 * list instead of asking them to recall a name. Pattern blocks such as `Host *`
 * are left out because they describe no particular machine, and no key material
 * is read here — only where each entry points.
 */
export async function listSshConfigHosts(configPath: string): Promise<SshConfigHostImport[]> {
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // No SSH configuration at all is an ordinary state, not a failure.
    if (code === "ENOENT") return [];
    throw new Error(`Could not read the SSH configuration at ${configPath}: ${code ?? "unreadable"}`);
  }
  const entries: SshConfigHostImport[] = [];
  let current: SshConfigHostImport[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [keyword, ...parts] = line.split(/\s+/);
    const directive = keyword?.toLocaleLowerCase();
    if (directive === "host") {
      current = [];
      for (const name of parts) {
        if (/^[A-Za-z0-9._-]{1,255}$/.test(name)) {
          const entry = { alias: name, identityKeyReadable: false };
          current.push(entry);
          entries.push(entry);
        }
      }
      continue;
    }
    if (!parts.length) continue;
    for (const entry of current) {
      if (directive === "hostname") entry.hostName = parts[0];
      else if (directive === "user") entry.username = parts[0];
      else if (directive === "port") {
        const port = Number(parts[0]);
        if (Number.isInteger(port) && port > 0 && port <= 65_535) entry.port = port;
      }
    }
  }
  return entries;
}

/**
 * Where a freshly generated key waits between "generate" and "register".
 *
 * The pair is made before the machine record exists, so the material has to live
 * somewhere the next call can name. It is written owner-only inside the product
 * data directory and deleted as soon as it has been stored encrypted, so the
 * loose copy is short-lived and the browser only ever sees the path.
 */
export function generatedKeyDirectory(dataDir: string): string {
  return resolve(dataDir, "ssh-keys");
}

export async function stageGeneratedKey(dataDir: string, privateKey: string): Promise<string> {
  const directory = generatedKeyDirectory(dataDir);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const path = resolve(directory, `${randomUUID()}.key`);
  await writeFile(path, privateKey, { mode: 0o600 });
  return path;
}

/** Remove a staged key once it is stored encrypted; other paths are left alone. */
export async function consumeStagedKey(dataDir: string, path: string): Promise<void> {
  const expanded = expandPrivateKeyPath(path);
  if (resolve(expanded).startsWith(`${generatedKeyDirectory(dataDir)}/`)) {
    await rm(expanded, { force: true });
  }
}

/**
 * The key material at `path`, when this process can read it. A key the user's
 * agent holds but this process cannot open is reported as unreadable, so the
 * settings page can offer a password or a generated key instead of failing at
 * connect time.
 */
export async function readablePrivateKey(path: string): Promise<string | undefined> {
  try {
    const key = await readFile(expandPrivateKeyPath(path), "utf8");
    return /BEGIN [A-Z ]*PRIVATE KEY/.test(key) ? key : undefined;
  } catch {
    return undefined;
  }
}

/** A leading ~ always refers to the API installation's user, not the browser. */
function expandPrivateKeyPath(path: string): string {
  return path === "~" ? os.homedir() : path.startsWith("~/") ? resolve(os.homedir(), path.slice(2)) : path;
}
