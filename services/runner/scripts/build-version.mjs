// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

export function buildIdentity({ revision = process.env.SCIENCE_AGENT_BUILD_COMMIT, git = args =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
} = {}) {
  // Exported source archives can supply the full commit from their release job.
  if (revision !== undefined) {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(revision)) {
      throw new Error("SCIENCE_AGENT_BUILD_COMMIT must be a full Git commit hash");
    }
    return { version: revision.slice(0, 8).toLowerCase(), commit: revision.toLowerCase() };
  }
  try {
    const commit = git(["rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) throw new Error("Invalid Git identity");
    // Mark tracked edits; unrelated untracked screenshots/data do not identify a build.
    const dirty = git(["status", "--porcelain", "--untracked-files=no"]) !== "";
    return { version: `${commit.slice(0, 8)}${dirty ? "-dirty" : ""}`, commit };
  } catch {
    return { version: "unknown", commit: null };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const identity = buildIdentity();
  await writeFile(new URL("../dist/build-info.json", import.meta.url), `${JSON.stringify(identity)}\n`);
  console.log(`Runner build: ${identity.version}`);
}
