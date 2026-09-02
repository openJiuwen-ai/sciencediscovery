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

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
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
        ? resolve(homedir(), parts[0].slice(2))
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
 * The key material at `path`, when this process can read it. A key the user's
 * agent holds but the product cannot open is reported as unreadable so the
 * settings page can ask them to paste one instead of failing at connect time.
 */
export async function readablePrivateKey(path: string): Promise<string | undefined> {
  try {
    const key = await readFile(path, "utf8");
    return /BEGIN [A-Z ]*PRIVATE KEY/.test(key) ? key : undefined;
  } catch {
    return undefined;
  }
}
