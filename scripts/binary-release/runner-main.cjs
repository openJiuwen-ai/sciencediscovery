// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

// The SEA carries the original ESM tree as an asset. Keep its module-relative
// data paths intact rather than rewriting import.meta for a flattened bundle.
const { getAsset } = require("node:sea");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { homedir } = require("node:os");
const { join, dirname, resolve, sep } = require("node:path");
const { createRequire } = require("node:module");
const { gunzipSync } = require("node:zlib");

try {
  const payload = Buffer.from(getAsset("runner"));
  const id = createHash("sha256").update(payload).digest("hex");
  const data = resolve(process.env.SCIENCE_AGENT_DATA_DIR || join(homedir(), ".local/share/sciencediscovery/remote-runner"));
  process.env.SCIENCE_AGENT_DATA_DIR = data;
  const root = join(data, "runtimes");
  const target = join(root, id);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(join(target, ".complete"))) {
    const stage = fs.mkdtempSync(join(root, ".stage-"));
    try {
      for (const file of JSON.parse(gunzipSync(payload))) {
        const path = resolve(stage, file.path);
        if (!path.startsWith(stage + sep)) throw new Error("Invalid embedded runner path");
        fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path, Buffer.from(file.content, "base64"), { mode: 0o600, flag: "wx" });
      }
      fs.writeFileSync(join(stage, ".complete"), id, { mode: 0o600 });
      try { fs.renameSync(stage, target); }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || !fs.existsSync(join(target, ".complete"))) throw error;
      }
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  const entry = join(target, "services/runner/dist/server.js");
  // Node 22.19 supports require(ESM). Setting argv[1] retains the normal server
  // entry guard; all execution, signing and sandbox code stays unchanged.
  process.argv[1] = entry;
  createRequire(entry)(entry);
} catch (error) {
  console.error(`Runner SEA startup failed: ${error.message}`);
  process.exitCode = 1;
}
