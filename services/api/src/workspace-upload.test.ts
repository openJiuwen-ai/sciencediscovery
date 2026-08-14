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
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { test, type TestContext } from "node:test";

import {
  allocateUploadPath,
  measureWorkspaceBytes,
  parseConflictPolicy,
  readMultipartUploads,
  sanitizeUploadFilename,
  writeWorkspaceUpload,
  type WorkspaceUploadLimits,
} from "./workspace-upload.js";

const limits: WorkspaceUploadLimits = {
  maxFileBytes: 1_024,
  maxRequestBytes: 4_096,
  maxWorkspaceBytes: 2_048,
};

async function tempWorkspace(context: TestContext, label: string): Promise<string> {
  const root = resolve(process.cwd(), ".tmp", `workspace-upload-${label}-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  context.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

test("sanitizeUploadFilename rejects absolute and traversal names", () => {
  assert.equal(sanitizeUploadFilename("sales.csv"), "sales.csv");
  assert.throws(() => sanitizeUploadFilename("../../outside.csv"), /plain basename/);
  assert.throws(() => sanitizeUploadFilename("C:\\\\temp\\\\data.bin"), /plain basename/);
  assert.throws(() => sanitizeUploadFilename("/tmp/data.bin"), /plain basename/);
  assert.throws(() => sanitizeUploadFilename("nested/path.csv"), /plain basename/);
  assert.throws(() => sanitizeUploadFilename(".."), /plain basename|invalid/);
});

test("parseConflictPolicy defaults to rename", () => {
  assert.equal(parseConflictPolicy(undefined), "rename");
  assert.equal(parseConflictPolicy("overwrite"), "overwrite");
  assert.throws(() => parseConflictPolicy("merge"), /conflict must be/);
});

test("allocateUploadPath renames on conflict by default", async (context) => {
  const workspace = await tempWorkspace(context, "rename");
  await writeFile(resolve(workspace, "input.csv"), "a\n");
  const first = await allocateUploadPath(workspace, "input.csv", "rename");
  assert.deepEqual(first, { path: "input-1.csv", status: "renamed" });
  await assert.rejects(allocateUploadPath(workspace, "input.csv", "reject"), /already exists/);
});

test("writeWorkspaceUpload rejects traversal names instead of basename collapse", async (context) => {
  const workspace = await tempWorkspace(context, "basename");
  await assert.rejects(
    writeWorkspaceUpload({
      bytes: Buffer.from("owned"),
      conflict: "overwrite",
      filename: "../../link/secret.bin",
      limits,
      workspaceRoot: workspace,
    }),
    /plain basename/,
  );
  await assert.rejects(stat(resolve(workspace, "secret.bin")), { code: "ENOENT" });
  await assert.rejects(stat(resolve(workspace, "..", "secret.bin")), { code: "ENOENT" });
});

test("readMultipartUploads keeps zero-byte file parts", async () => {
  const boundary = "----sa-empty-upload";
  const body = Buffer.from(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="empty.txt"',
      "",
      "",
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="notes.txt"',
      "",
      "hello",
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  );
  const request = Readable.from([body]) as IncomingMessage;
  request.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  const parts = await readMultipartUploads(request, 4_096);
  assert.equal(parts.length, 2);
  assert.equal(parts[0]?.filename, "empty.txt");
  assert.equal(parts[0]?.bytes.length, 0);
  assert.equal(parts[1]?.filename, "notes.txt");
  assert.equal(parts[1]?.bytes.toString("utf8"), "hello");
});

test("writeWorkspaceUpload accepts empty files", async (context) => {
  const workspace = await tempWorkspace(context, "empty");
  const written = await writeWorkspaceUpload({
    bytes: Buffer.alloc(0),
    conflict: "rename",
    filename: "empty.txt",
    limits,
    workspaceRoot: workspace,
  });
  assert.equal(written.path, "empty.txt");
  assert.equal(written.bytesWritten, 0);
  assert.equal((await readFile(resolve(workspace, "empty.txt"))).length, 0);
  assert.equal(await measureWorkspaceBytes(workspace), 0);
});

test("readMultipartUploads allows body when maxRequestBytes is 0 (unlimited)", async () => {
  const boundary = "----sa-unlimited-upload";
  const body = Buffer.from(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="notes.txt"',
      "",
      "hello",
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  );
  const request = Readable.from([body]) as IncomingMessage;
  request.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  const parts = await readMultipartUploads(request, 0);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]?.filename, "notes.txt");
  assert.equal(parts[0]?.bytes.toString("utf8"), "hello");
});

test("writeWorkspaceUpload enforces file and workspace quotas", async (context) => {
  const workspace = await tempWorkspace(context, "quota");
  const quotaLimits: WorkspaceUploadLimits = {
    maxFileBytes: 1_500,
    maxRequestBytes: 4_096,
    maxWorkspaceBytes: 2_048,
  };
  await assert.rejects(
    writeWorkspaceUpload({
      bytes: Buffer.alloc(2_000),
      conflict: "rename",
      filename: "big.bin",
      limits: quotaLimits,
      workspaceRoot: workspace,
    }),
    /upload limit/,
  );
  await writeWorkspaceUpload({
    bytes: Buffer.alloc(1_000),
    conflict: "rename",
    filename: "a.bin",
    limits: quotaLimits,
    workspaceRoot: workspace,
  });
  await assert.rejects(
    writeWorkspaceUpload({
      bytes: Buffer.alloc(1_100),
      conflict: "rename",
      filename: "b.bin",
      limits: quotaLimits,
      workspaceRoot: workspace,
    }),
    /workspace quota/,
  );
  assert.equal(await measureWorkspaceBytes(workspace), 1_000);
  assert.equal((await readFile(resolve(workspace, "a.bin"))).length, 1_000);
});
