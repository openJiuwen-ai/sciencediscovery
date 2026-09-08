// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { ApiStatusError } from "../runs/index.js";

import { handleKeGetEntity, handleKeListKbs, KeApiError } from "./routes.js";
import { KnowledgeEngineStore } from "./store.js";

function tempRoot(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

/** Minimal ServerResponse stand-in capturing status+body. */
function fakeResponse(): { status: number; body: string; response: import("node:http").ServerResponse } {
  const captured = { status: 0, body: "" };
  const response = {
    writeHead(status: number) {
      captured.status = status;
      return response;
    },
    end(body?: string) {
      captured.body = body ?? "";
    },
  } as unknown as import("node:http").ServerResponse;
  return { ...captured, response };
}

test("KeApiError is an ApiStatusError (top-level classifier maps it, never a bare 500)", () => {
  const error = new KeApiError("entity x not found", 404, "KE_ENTITY_NOT_FOUND");
  assert.ok(error instanceof ApiStatusError);
  assert.equal(error.statusCode, 404);
  assert.equal(error.code, "KE_ENTITY_NOT_FOUND");
});

test("handleKeGetEntity throws a classifiable 404 for a missing entity", async (context) => {
  const root = tempRoot("ke-routes-404");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());

  const { response } = fakeResponse();
  assert.throws(
    () => handleKeGetEntity(response, store, "nonexistent"),
    (error: unknown) => error instanceof ApiStatusError && error.statusCode === 404 && error.code === "KE_ENTITY_NOT_FOUND",
  );
});

test("handleKeListKbs returns kbs with SQL-computed stats", async (context) => {
  const root = tempRoot("ke-routes-list");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  store.upsertDocument({ kbId: kb.id, dedupKey: "doi:1", title: "A", status: "ready" });
  store.upsertEntity({ kbId: kb.id, name: "GP", type: "protein" });

  const captured = { status: 0, body: "" };
  const response = {
    writeHead(status: number) {
      captured.status = status;
      return response;
    },
    end(body?: string) {
      captured.body = body ?? "";
    },
  } as unknown as import("node:http").ServerResponse;

  handleKeListKbs(response, store);
  const payload = JSON.parse(captured.body) as { kbs: Array<{ stats: { documents: number; entities: number } }> };
  assert.equal(payload.kbs.length, 1);
  assert.equal(payload.kbs[0]?.stats.documents, 1);
  assert.equal(payload.kbs[0]?.stats.entities, 1);
});
