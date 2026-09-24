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

/**
 * HTTP-level coverage for POST /api/skill-review-drafts/bulk-publish-git.
 * Real Git drafts are seeded onto the shared data directory before the API
 * server starts, so the route sees exactly what a browser quick import
 * would see after `createGitSkillReviewDrafts`.
 */

import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";

import { SkillCatalog } from "@sciencediscovery/specialist";
import type { BulkPublishGitSkillReviewDraftsResponse } from "@sciencediscovery/schema";

import type { ServerConfig } from "./bootstrap/config.js";
import { createApiServer } from "./http/index.js";
import { SessionStore } from "./store.js";

function serverConfig(root: string): ServerConfig {
  return {
    authToken: "test-token", dataDir: root, host: "127.0.0.1", port: 0,
    gatewayIdleTimeoutMs: 240_000, gatewayTurnTimeoutMs: 0, kernelIdleTimeoutMs: 0,
    modelCatalogPath: resolve(root, "absent.json"), paperPythonPath: resolve(root, "no-python"),
    paperWorkerPath: resolve(root, "no-worker"), permissionWaitTimeoutMs: 0, runnerExecTimeoutMs: 0,
    runnerMaxOutputBytes: 1_000_000, runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "runner-test-token", runnerUrl: "http://127.0.0.1:1",
    sshConfigPath: resolve(root, "ssh-config"), staticDir: resolve(root, "no-web"),
    workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_737_418_240 },
    memoryGraph: { url: "http://127.0.0.1:1", internalToken: "test" },
    evolve: { url: "http://127.0.0.1:1", internalToken: "test" },
  };
}

async function seedGitDrafts(root: string, repositoryRoot: string, names: string[]): Promise<string[]> {
  const catalog = new SkillCatalog(root, repositoryRoot);
  await catalog.load();
  const commit = "bulk0123456789abcdefbulk0123456789abcdef";
  const drafts = [];
  for (const name of names) {
    drafts.push(await catalog.createReviewDraft({
      description: `Bulk HTTP candidate ${name}.`,
      instructions: `# Workflow\n\nRun ${name}.`,
      name,
    }, {
      git: { commit, ref: "main", repositoryUrl: "https://example.com/bulk-http.git", subdirectory: `skills/${name}` },
      source: "git",
    }));
  }
  return drafts.map((draft) => draft.draftId);
}

test("bulk publish Git review drafts commits one library version and sweeps the drafts", async (context) => {
  const repositoryRoot = resolve(process.cwd(), "../..");
  const root = resolve(process.cwd(), ".tmp", `bulk-git-api-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const draftIds = await seedGitDrafts(root, repositoryRoot, ["bulk-http-alpha", "bulk-http-beta"]);

  const store = new SessionStore(root);
  store.setAvailableSkillIds([]);
  await store.load();
  const catalog = { loadedAt: new Date().toISOString(), revision: "bulk-git-test", servers: [] };
  const server = createApiServer(serverConfig(root), {
    mcpTransport: {
      catalog: async () => catalog, reload: async () => catalog,
      invoke: async () => { throw new Error("No MCP in this test"); },
    },
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.after(async () => {
    await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
    await rm(root, { force: true, recursive: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, body?: unknown, method = "POST") => fetch(`${origin}${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    method,
  });

  // Happy path: both drafts become one library version, drafts are swept.
  const published = await request("/api/skill-review-drafts/bulk-publish-git", {
    draftIds,
    presetId: "https://example.com/bulk-http.git",
  });
  const publishedBody = await published.json() as BulkPublishGitSkillReviewDraftsResponse;
  assert.equal(published.status, 201, JSON.stringify(publishedBody));
  assert.equal(publishedBody.version?.author.kind, "system");
  assert.equal(publishedBody.version?.author.name, "Quick Git import");
  assert.deepEqual(
    publishedBody.version?.skills.map((skill) => skill.id).sort(),
    ["bulk-http-alpha", "bulk-http-beta"],
  );
  const autoImport = (publishedBody.version?.evaluation?.autoImport ?? {}) as {
    count?: number;
    repositoryUrl?: string;
  };
  assert.equal(autoImport.count, 2);
  assert.equal(autoImport.repositoryUrl, "https://example.com/bulk-http.git");
  assert.deepEqual(publishedBody.skipped, []);
  assert.deepEqual(publishedBody.conflicts, []);

  const remaining = await request("/api/skill-review-drafts", undefined, "GET");
  assert.deepEqual(await remaining.json(), []);

  // The bulk-published Skills must also land in SkillCatalog.list() so the
  // Skills tab search and SkillWorkspaceDialog can find them. We check the
  // exact names against the response so a future catalog-wide change does
  // not silently flip this contract.
  const skills = await request("/api/skills", undefined, "GET");
  const skillIds = (await skills.json() as Array<{ id: string }>).map((skill) => skill.id);
  for (const id of ["bulk-http-alpha", "bulk-http-beta"]) {
    assert.ok(skillIds.includes(id), `expected /api/skills to include ${id}; got ${JSON.stringify(skillIds)}`);
  }

  // Idempotence guard: the drafts are gone, so re-publishing is a 404.
  const replay = await request("/api/skill-review-drafts/bulk-publish-git", { draftIds });
  assert.equal(replay.status, 404, await replay.text());

  // Validation: empty batch and built-in library are rejected.
  const empty = await request("/api/skill-review-drafts/bulk-publish-git", { draftIds: [] });
  assert.equal(empty.status, 400, await empty.text());
  const builtIn = await request("/api/skill-review-drafts/bulk-publish-git", {
    draftIds: ["any-draft"],
    libraryId: "built-in-skills",
  });
  assert.equal(builtIn.status, 400, await builtIn.text());
});

test("bulk publish honors filter mode and reports skipped drafts", async (context) => {
  const repositoryRoot = resolve(process.cwd(), "../..");
  const root = resolve(process.cwd(), ".tmp", `bulk-git-filter-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const draftIds = await seedGitDrafts(root, repositoryRoot, ["filter-alpha"]);
  draftIds.push("already-gone-draft");
  // Seeded up front: the API server loads its catalogs once at startup, so
  // drafts written to disk afterwards are invisible to it.
  const failModeIds = await seedGitDrafts(root, repositoryRoot, ["fail-mode-alpha"]);
  failModeIds.push("another-missing-draft");

  const store = new SessionStore(root);
  store.setAvailableSkillIds([]);
  await store.load();
  const catalog = { loadedAt: new Date().toISOString(), revision: "bulk-git-filter-test", servers: [] };
  const server = createApiServer(serverConfig(root), {
    mcpTransport: {
      catalog: async () => catalog, reload: async () => catalog,
      invoke: async () => { throw new Error("No MCP in this test"); },
    },
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.after(async () => {
    await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
    await rm(root, { force: true, recursive: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, body?: unknown, method = "POST") => fetch(`${origin}${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    method,
  });

  const filtered = await request("/api/skill-review-drafts/bulk-publish-git", {
    draftIds,
    onConflict: "filter",
  });
  const filteredBody = await filtered.json() as BulkPublishGitSkillReviewDraftsResponse;
  assert.equal(filtered.status, 201, JSON.stringify(filteredBody));
  assert.equal(filteredBody.version?.skills.length, 1);
  assert.equal(filteredBody.skipped.length, 1);
  assert.equal(filteredBody.skipped[0]?.draftId, "already-gone-draft");

  // The same batch with fail mode must reject without committing anything.
  const failed = await request("/api/skill-review-drafts/bulk-publish-git", {
    draftIds: failModeIds,
  });
  assert.equal(failed.status, 404, await failed.text());
  const draftsLeft = await request("/api/skill-review-drafts", undefined, "GET");
  const left = await draftsLeft.json() as Array<{ name: string }>;
  assert.deepEqual(left.map((draft) => draft.name), ["fail-mode-alpha"]);
});
