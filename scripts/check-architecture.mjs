// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const root = new URL("../", import.meta.url);

async function sourceFiles(path) {
  const entries = await readdir(new URL(path, root), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ["dist", "node_modules"].includes(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(child));
    else if ([".ts", ".tsx", ".js", ".mjs"].includes(extname(entry.name))) files.push(child);
  }
  return files;
}

const failures = [];
const packageFiles = await sourceFiles("packages");
for (const file of packageFiles) {
  const source = await readFile(new URL(file, root), "utf8");
  if (/from\s+["'][^"']*(?:services|apps)\//u.test(source)) {
    failures.push(`${file}: packages must not import services/ or apps/`);
  }
  if (source.includes("@science-agent/agent-runtime")) {
    failures.push(`${file}: capability packages must not depend on the compatibility facade`);
  }
}

for (const file of await sourceFiles("services")) {
  if (file.endsWith(".test.ts")) continue;
  const source = await readFile(new URL(file, root), "utf8");
  if (source.includes("@science-agent/agent-runtime")) {
    failures.push(`${file}: production services must import the owning capability package directly`);
  }
}

for (const file of await sourceFiles("test")) {
  const source = await readFile(new URL(file, root), "utf8");
  if (source.includes("@science-agent/agent-runtime")) {
    failures.push(`${file}: tests must import the owning capability package directly`);
  }
}

for (const file of await sourceFiles("packages/runtime-core/src")) {
  if (file.endsWith(".test.ts")) continue;
  const source = await readFile(new URL(file, root), "utf8");
  if (/from\s+["'][^./]/u.test(source)) failures.push(`${file}: runtime-core may only use relative imports`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Architecture boundaries OK (${packageFiles.length} package source files checked)`);
}
