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

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type {
  CommitSkillLibraryVersionResult,
  SkillLibrary,
  SkillLibraryDiff,
  SkillLibrarySearchResult,
  SkillLibraryVersion,
} from "@sciencediscovery/schema";

import { SkillLibraryCatalog } from "./skill-library-catalog.js";
import { handleSkillLibraryRequest } from "./http/skill-libraries.js";

async function temporaryDataDir(): Promise<string> {
  const root = resolve(process.cwd(), ".tmp");
  await mkdir(root, { recursive: true });
  return await mkdtemp(resolve(root, "skill-library-api-test-"));
}

function skillPackage(name: string, description = "A test skill committed through HTTP.") {
  return {
    files: [{
      content: `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  version: 1.0.0\n---\n\n# ${name}\n`,
      path: "SKILL.md",
    }],
  };
}

async function apiJsonRequest<T>(
  catalog: SkillLibraryCatalog,
  path: string,
  init: { body?: unknown; method?: string } = {},
): Promise<{ body: T; status: number }> {
  const rawBody = init.body === undefined ? undefined : JSON.stringify(init.body);
  const request = Readable.from(rawBody === undefined ? [] : [Buffer.from(rawBody)]) as unknown as IncomingMessage;
  request.headers = {
    ...(rawBody === undefined ? {} : { "content-type": "application/json" }),
  };
  request.method = init.method ?? "GET";
  request.url = path;
  const result = await new Promise<{ body: string; status: number }>((resolveResult, reject) => {
    const response = {
      end(body?: string | Buffer) {
        resolveResult({
          body: Buffer.isBuffer(body) ? body.toString("utf8") : body ?? "",
          status: this.statusCode,
        });
      },
      statusCode: 200,
      writeHead(statusCode: number) {
        this.statusCode = statusCode;
      },
    } as ServerResponse;
    Promise.resolve(handleSkillLibraryRequest({
      catalog,
      request,
      response,
      url: new URL(path, "http://localhost"),
    })).then((handled) => {
      if (!handled) reject(new Error(`Unhandled skill library route: ${init.method ?? "GET"} ${path}`));
    }).catch(reject);
  });
  return { body: JSON.parse(result.body) as T, status: result.status };
}

test("skill library HTTP APIs create, dry-run, commit, diff, and rollback versions", async (context) => {
  const dataDir = await temporaryDataDir();
  context.after(() => rmSync(dataDir, { force: true, recursive: true }));
  const catalog = new SkillLibraryCatalog(dataDir);
  await catalog.load();

    const created = await apiJsonRequest<SkillLibrary>(catalog, "/api/skill-libraries", {
      body: { id: "http-library", name: "HTTP Library" },
      method: "POST",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.id, "http-library");

    const listed = await apiJsonRequest<SkillLibrary[]>(catalog, "/api/skill-libraries");
    assert.deepEqual(listed.body.map((library) => library.id), ["http-library"]);

    const first = await apiJsonRequest<CommitSkillLibraryVersionResult>(catalog, "/api/skill-libraries/http-library/versions", {
      body: {
        author: { kind: "self-evolution", name: "test-loop" },
        operations: [
          { package: skillPackage("alpha-http-skill"), type: "upsert" },
          { package: skillPackage("beta-http-skill"), type: "upsert" },
        ],
      },
      method: "POST",
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.version?.skills.length, 2);

    const dryRun = await apiJsonRequest<CommitSkillLibraryVersionResult>(catalog, "/api/skill-libraries/http-library/versions", {
      body: {
        author: { kind: "user" },
        baseVersionId: first.body.version!.id,
        dryRun: true,
        operations: [
          { package: skillPackage("alpha-http-skill", "A revised test skill committed through HTTP."), type: "upsert" },
          { skillId: "beta-http-skill", type: "delete" },
        ],
      },
      method: "POST",
    });
    assert.equal(dryRun.status, 200);
    assert.equal(dryRun.body.diff.modified[0]?.skillId, "alpha-http-skill");
    assert.equal(dryRun.body.diff.deleted[0]?.skillId, "beta-http-skill");
    const afterDryRun = await apiJsonRequest<SkillLibraryVersion[]>(catalog, "/api/skill-libraries/http-library/versions");
    assert.equal(afterDryRun.body.length, 1);

    const second = await apiJsonRequest<CommitSkillLibraryVersionResult>(catalog, "/api/skill-libraries/http-library/versions", {
      body: {
        author: { kind: "user" },
        baseVersionId: first.body.version!.id,
        operations: [
          { package: skillPackage("alpha-http-skill", "A revised test skill committed through HTTP."), type: "upsert" },
          { skillId: "beta-http-skill", type: "delete" },
        ],
      },
      method: "POST",
    });
    assert.equal(second.status, 201);

    const search = await apiJsonRequest<SkillLibrarySearchResult>(catalog, "/api/skill-libraries/search", {
      body: {
        libraries: [{
          contentHash: second.body.version!.contentHash,
          libraryId: "http-library",
          priority: 2,
          versionId: second.body.version!.id,
        }],
        limit: 1,
        query: "revised test skill",
      },
      method: "POST",
    });
    assert.equal(search.status, 200);
    assert.deepEqual(search.body.candidates.map((candidate) => candidate.skill.id), ["alpha-http-skill"]);

    const diff = await apiJsonRequest<SkillLibraryDiff>(
      catalog,
      `/api/skill-libraries/http-library/versions/${first.body.version!.id}/diff/${second.body.version!.id}`,
    );
    assert.deepEqual(diff.body.modified.map((entry) => entry.skillId), ["alpha-http-skill"]);
    assert.deepEqual(diff.body.deleted.map((entry) => entry.skillId), ["beta-http-skill"]);

    const rollback = await apiJsonRequest<CommitSkillLibraryVersionResult>(catalog, "/api/skill-libraries/http-library/rollback", {
      body: {
        author: { kind: "user" },
        baseVersionId: second.body.version!.id,
        targetVersionId: first.body.version!.id,
      },
      method: "POST",
    });
    assert.equal(rollback.status, 201);
    assert.equal(rollback.body.version?.rollbackOfVersionId, first.body.version?.id);

    const current = await apiJsonRequest<SkillLibrary>(catalog, "/api/skill-libraries/http-library");
    assert.equal(current.body.headVersionId, rollback.body.version?.id);
});

test("skill library HTTP APIs return conflicts without publishing stale writes", async (context) => {
  const dataDir = await temporaryDataDir();
  context.after(() => rmSync(dataDir, { force: true, recursive: true }));
  const catalog = new SkillLibraryCatalog(dataDir);
  await catalog.load();
  await apiJsonRequest<SkillLibrary>(catalog, "/api/skill-libraries", {
      body: { id: "stale-http-library" },
      method: "POST",
    });
    const first = await apiJsonRequest<CommitSkillLibraryVersionResult>(catalog, "/api/skill-libraries/stale-http-library/versions", {
      body: {
        author: { kind: "user" },
        operations: [{ package: skillPackage("alpha-http-skill"), type: "upsert" }],
      },
      method: "POST",
    });
    const stale = await apiJsonRequest<CommitSkillLibraryVersionResult>(catalog, "/api/skill-libraries/stale-http-library/versions", {
      body: {
        author: { kind: "user" },
        operations: [{ package: skillPackage("beta-http-skill"), type: "upsert" }],
      },
      method: "POST",
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.conflicts[0]?.code, "STALE_BASE_VERSION");

    const current = await apiJsonRequest<SkillLibrary>(catalog, "/api/skill-libraries/stale-http-library");
    assert.equal(current.body.headVersionId, first.body.version?.id);
});
