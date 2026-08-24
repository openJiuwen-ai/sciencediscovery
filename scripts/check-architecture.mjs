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
const allSourceFiles = new Set([
  ...packageFiles,
  ...await sourceFiles("services"),
]);
for (const file of packageFiles) {
  const source = await readFile(new URL(file, root), "utf8");
  if (/from\s+["'][^"']*(?:services|apps)\//u.test(source)) {
    failures.push(`${file}: packages must not import services/ or apps/`);
  }
  if (source.includes("@sciencediscovery/agent-runtime")) {
    failures.push(`${file}: capability packages must not depend on the compatibility facade`);
  }
}

for (const file of await sourceFiles("services")) {
  if (file.endsWith(".test.ts")) continue;
  const source = await readFile(new URL(file, root), "utf8");
  if (source.includes("@sciencediscovery/agent-runtime")) {
    failures.push(`${file}: production services must import the owning capability package directly`);
  }
}

for (const file of await sourceFiles("test")) {
  const source = await readFile(new URL(file, root), "utf8");
  if (source.includes("@sciencediscovery/agent-runtime")) {
    failures.push(`${file}: tests must import the owning capability package directly`);
  }
}

for (const file of await sourceFiles("packages/runtime-core/src")) {
  if (file.endsWith(".test.ts")) continue;
  const source = await readFile(new URL(file, root), "utf8");
  if (/from\s+["'][^./]/u.test(source)) failures.push(`${file}: runtime-core may only use relative imports`);
}

// Once a domain source has an owning package, recreating the old service file
// would silently restore split ownership and duplicate policy.
const removedServiceDomainSources = [
  "services/api/src/builtin-specialists.ts",
  "services/api/src/agent-run/permission-runtime.ts",
  "services/api/src/environment.ts",
  "services/api/src/http/config.ts",
  "services/api/src/mcp/artifact-manager.ts",
  "services/api/src/mcp/broker.ts",
  "services/api/src/mcp/governed-download-manager.ts",
  "services/api/src/mcp/result-cache.ts",
  "services/api/src/mcp/source-catalog.ts",
  "services/api/src/mcp/transport.ts",
  "services/api/src/mcp/workspace-tools.ts",
  "services/api/src/memory-graph-log.ts",
  "services/api/src/memory-graph.ts",
  "services/api/src/provenance.ts",
  "services/api/src/proxy/dispatcher.ts",
  "services/api/src/proxy/env.ts",
  "services/api/src/proxy/index.ts",
  "services/api/src/proxy/resolve.ts",
  "services/api/src/proxy/system.ts",
  "services/api/src/rate-limit/resource-rate-limiter.ts",
  "services/api/src/remote-compute.ts",
  "services/api/src/reviewer-specialist/citation-review.ts",
  "services/api/src/reviewer-specialist/computation-review.ts",
  "services/api/src/reviewer-specialist/review-log.ts",
  "services/api/src/reviewer-specialist/review-policy.ts",
  "services/api/src/reviewer-specialist/review-checkpoint.ts",
  "services/api/src/runner-client.ts",
  "services/api/src/skills.ts",
  "services/api/src/store/permissions.ts",
  "services/api/src/web-providers/broker.ts",
  "services/api/src/web-providers/cache.ts",
  "services/api/src/web-providers/workspace-tools.ts",
  "services/api/src/subagent-lifecycle.ts",
];
for (const file of removedServiceDomainSources) {
  if (allSourceFiles.has(file)) failures.push(`${file}: domain source belongs in its capability package`);
}

const httpEntry = await readFile(new URL("services/api/src/http/index.ts", root), "utf8");
if (!httpEntry.includes("createPlatformServices(")) {
  failures.push("services/api/src/http/index.ts: HTTP entry must use the platform composition root");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Architecture boundaries OK (${packageFiles.length} package source files checked)`);
}
