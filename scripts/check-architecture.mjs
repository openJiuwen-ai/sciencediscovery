// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { checkComponentBoundaries } from "./component-boundaries.mjs";

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
if (await stat(new URL("plugins", root)).then(() => true, () => false)) {
  // Ignore leftover build output, but never reintroduce a second source tree.
  if ((await sourceFiles("plugins")).length) failures.push("plugins/: components belong in packages/, not a parallel plugin tree");
}
const allSourceFiles = new Set([
  ...packageFiles,
  ...await sourceFiles("services"),
]);
const manifests = [];
for (const parent of ["packages", "services", "apps"]) {
  for (const entry of await readdir(new URL(parent, root), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = `${parent}/${entry.name}`;
    try { manifests.push({ ...JSON.parse(await readFile(new URL(`${directory}/package.json`, root), "utf8")), directory }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
const graphFiles = [...allSourceFiles, ...await sourceFiles("apps")];
const graphSources = new Map(await Promise.all(graphFiles.map(async file => [file, await readFile(new URL(file, root), "utf8")])));
// Existing Runner deployment coupling predates component consolidation. Freeze
// the exact edge/files rather than exempting executor or all service imports.
// Removing it requires a separate Runner artifact/provisioning contract migration.
const legacyRunnerDependency = {
  from: "@sciencediscovery/executor", to: "@sciencediscovery/runner",
  files: ["packages/executor/package.json", ...[
    "environment.ts", "environment.test.ts", "remote-provisioner.ts", "remote-provisioner.test.ts",
    "remote-skill-packages.test.ts", "runner-client.ts",
  ].map(name => `packages/executor/src/${name}`)],
};
failures.push(...checkComponentBoundaries(manifests, graphSources, [legacyRunnerDependency]));
for (const file of packageFiles) {
  const source = await readFile(new URL(file, root), "utf8");
  if (/from\s+["'][^"']*(?:services|apps)\//u.test(source)) {
    failures.push(`${file}: packages must not import services/ or apps/`);
  }
  if (source.includes("@sciencediscovery/agent-runtime")) {
    failures.push(`${file}: capability packages must not depend on the compatibility facade`);
  }
}

for (const file of await sourceFiles("packages/plugin-sdk/src")) {
  if (file.endsWith(".test.ts") || (!file.includes("/web.") && !file.endsWith("/views.ts") && !file.includes("/plugin-sdk/"))) continue;
  const source = await readFile(new URL(file, root), "utf8");
  if (/from\s+["']node:/u.test(source)) failures.push(`${file}: browser-facing plugin modules must not import Node builtins`);
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

// Context assembly is an extension point for domain packages. Keeping its
// dependencies pointed only at the runtime/model contracts prevents a cycle
// when workspace, specialist, provenance, and other capabilities register
// contributors in #144.
for (const file of await sourceFiles("packages/context/src")) {
  const source = await readFile(new URL(file, root), "utf8");
  for (const match of source.matchAll(/from\s+["'](@sciencediscovery\/[^"']+)["']/gu)) {
    if (!["@sciencediscovery/model", "@sciencediscovery/runtime-core"].includes(match[1])) {
      failures.push(`${file}: context may only depend on model and runtime-core package contracts`);
    }
  }
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
