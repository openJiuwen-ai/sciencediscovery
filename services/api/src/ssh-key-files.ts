// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SshKeyFileListing } from "@sciencediscovery/schema";

const PAGE_SIZE = 100;

/** User-initiated, authenticated host browsing; never open file contents. */
export async function listSshKeyFiles(path?: string, offset = 0, home = homedir()): Promise<SshKeyFileListing> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid directory page");
  if (path?.includes("\0")) throw new Error("Invalid directory path");
  let directory = !path ? join(home, ".ssh") : path === "~" ? home
    : path.startsWith("~/") ? resolve(home, path.slice(2)) : path;
  if (!isAbsolute(directory)) throw new Error("Enter an absolute path or a path starting with ~/");
  directory = resolve(directory);
  try {
    let info;
    try { info = await stat(directory); } catch (error) {
      // An installation with no .ssh directory can still choose a key elsewhere.
      if (path || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      directory = home;
      info = await stat(directory);
    }
    if (info.isFile()) directory = dirname(directory);
    else if (!info.isDirectory()) throw new Error("Choose a directory or a regular key file");
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const page = await Promise.all(entries.slice(offset, offset + PAGE_SIZE).map(async (entry) => {
      const entryPath = join(directory, entry.name);
      let kind: SshKeyFileListing["entries"][number]["kind"] = "unavailable";
      try {
        // Follow symlinks for navigation, but do not treat sockets/FIFOs/devices as keys.
        const info = entry.isSymbolicLink() ? await stat(entryPath) : entry;
        if (info.isDirectory()) kind = "directory";
        else if (info.isFile()) kind = "file";
      } catch { /* A broken/inaccessible link remains visible but unselectable. */ }
      return { name: entry.name, path: entryPath, kind };
    }));
    const parent = dirname(directory);
    return { directory, parentDirectory: parent === directory ? null : parent, entries: page,
      nextOffset: offset + PAGE_SIZE < entries.length ? offset + PAGE_SIZE : null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new Error("ScienceDiscovery does not have permission to browse this directory");
    if (code === "ENOENT" || code === "ENOTDIR") throw new Error("This directory does not exist on the application machine");
    throw new Error("Could not browse this location on the application machine");
  }
}
