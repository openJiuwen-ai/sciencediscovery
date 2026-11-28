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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import { createApiServer, closeApiServer } from "./index.js";
import { researchPackageRefusal, RESEARCH_PACKAGE_INVALID_CODE, RESEARCH_PACKAGE_TRUNCATED_CODE } from "./research-package-refusal.js";
import { offlineMcpTransport } from "../mcp/offline-transport.fixture.js";
import type { ServerConfig } from "../bootstrap/config.js";

const PROJECT_PATH = "/api/projects/0123456789abcdef/research-package/inspect";

function refusalOf(message: string, code?: string) {
  const error = Object.assign(new Error(message), code ? { code } : {});
  return researchPackageRefusal(error, PROJECT_PATH);
}

test("a decompressor refusal is the caller's file, with a stable code and a sentence to show", () => {
  const truncated = refusalOf("unexpected end of file", "Z_BUF_ERROR");
  assert.equal(truncated?.status, 400);
  assert.equal(truncated?.code, RESEARCH_PACKAGE_TRUNCATED_CODE);
  assert.match(truncated?.message ?? "", /not a valid research package/u);

  const notGzip = refusalOf("incorrect header check", "Z_DATA_ERROR");
  assert.equal(notGzip?.status, 400);
  assert.equal(notGzip?.code, RESEARCH_PACKAGE_INVALID_CODE);
  assert.match(notGzip?.message ?? "", /not a gzip archive/u);
});

test("a package the parser refused answers 400 with the parser's own reason", () => {
  for (const message of [
    "Invalid .sdresearch gzip archive",
    "Research package is missing its manifest or records",
    "Research package contains a non-regular file",
    "Package checksum mismatch: objects/abc",
    "File is not listed in the package inventory: objects/abc",
    "Unsafe research package path",
  ]) {
    const refusal = refusalOf(message);
    assert.equal(refusal?.status, 400, message);
    assert.equal(refusal?.code, RESEARCH_PACKAGE_INVALID_CODE, message);
    assert.match(refusal?.message ?? "", /not a valid research package/u);
    assert.ok((refusal?.message ?? "").includes(message), `the parser's sentence is kept for the log reader: ${message}`);
  }

  const metadata = refusalOf("Research package metadata entry is too large");
  assert.equal(metadata?.status, 413);
  assert.match(metadata?.message ?? "", /metadata/u);
});

test("failures that are not the caller's file keep their 500", () => {
  // Our own exporter faults, a filesystem failure and a programming error are
  // not things the uploader can fix, so they must not be reported as a bad file.
  for (const message of [
    "A synchronous export cannot stream package objects",
    "Package object size changed while hashing",
    "Some unrelated server failure",
  ]) {
    assert.equal(refusalOf(message), undefined, message);
  }
  assert.equal(refusalOf("ENOSPC: no space left on device", "ENOSPC"), undefined);
  // The rule is scoped to the two endpoints a package can be uploaded to.
  assert.equal(researchPackageRefusal(new Error("incorrect header check"), "/api/projects/x/research-package/preview"), undefined);
  assert.equal(researchPackageRefusal(new Error("incorrect header check"), "/api/projects/x/research-package"), undefined);
});

/** The four payloads #1540 measured: random bytes, a truncated archive, a gzip
 *  header on its own, and a JSON body. */
function malformedPayloads(archive: Buffer) {
  return [
    { name: "64 KiB of random bytes", bytes: randomBytes(64 * 1024) },
    { name: "an archive truncated to half", bytes: archive.subarray(0, Math.floor(archive.length / 2)) },
    { name: "a gzip header on its own", bytes: archive.subarray(0, 12) },
    { name: "a JSON body", bytes: Buffer.from('{"hello":"world"}') },
  ];
}

/** A gzip stream of our own: the issue's truncated and header-only payloads are
 *  cut from a real archive, and cutting any gzip stream reaches the same parser
 *  with the same fault. */
function archiveBytes() {
  return gzipSync(Buffer.alloc(4096, 7));
}

/** One tar header, checksum filled in: the parser reads the type flag and
 *  refuses everything that is not a regular file. */
function tarHeader(name: string, size: number, type: string): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8);
  header.write("0000000\0", 108, 8);
  header.write("0000000\0", 116, 8);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  header.write("00000000000\0", 136, 12);
  header.write("        ", 148, 8);
  header.write(type, 156, 1);
  header.write("ustar\0" + "00", 257, 8);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

/** What `tar czf` of a folder produces: a directory entry before the file, so
 *  the "simply the wrong file" case reaches the parser's own refusal rather
 *  than the decompressor's. */
function archiveWithDirectoryEntry(): Buffer {
  const body = Buffer.from("hello\n");
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return gzipSync(Buffer.concat([
    tarHeader("pkg/", 0, "5"),
    tarHeader("pkg/a.txt", body.length, "0"),
    body,
    padding,
    Buffer.alloc(1024, 0),
  ]));
}

async function fixture(context: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), "research-package-invalid-"));
  const graph = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end('{"ok":true}');
  });
  await new Promise<void>((done) => graph.listen(0, "127.0.0.1", done));
  const config: ServerConfig = {
    sampleSession: false, authToken: "test-token", dataDir: root, host: "127.0.0.1", port: 0,
    gatewayIdleTimeoutMs: 240_000, gatewayTurnTimeoutMs: 0, kernelIdleTimeoutMs: 0,
    modelCatalogPath: resolve(root, "absent.json"), paperPythonPath: resolve(root, "no-python"), paperWorkerPath: resolve(root, "no-worker"),
    permissionWaitTimeoutMs: 0, runnerExecTimeoutMs: 0, runnerMaxOutputBytes: 1_000_000, runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "runner-test-token", runnerUrl: "http://127.0.0.1:1", sshConfigPath: resolve(root, "ssh-config"), staticDir: resolve(root, "no-web"),
    workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_737_418_240 },
    memoryGraph: { url: `http://127.0.0.1:${(graph.address() as AddressInfo).port}`, internalToken: "test" },
    evolve: { url: "http://127.0.0.1:1", internalToken: "test" },
  };
  const server = createApiServer(config, {
    mcpTransport: offlineMcpTransport,
    measureResearchPackageCapacity: async () => ({ freeDiskBytes: Number.POSITIVE_INFINITY, freeMemoryBytes: Number.POSITIVE_INFINITY }),
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.after(async () => {
    await closeApiServer(server);
    await new Promise<void>((done) => graph.close(() => done()));
    await rm(root, { force: true, recursive: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, {
    ...init,
    headers: { authorization: "Bearer test-token", ...(init.headers ?? {}) },
  });
  const project = async () => await (await request("/api/projects", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `坏包验证 ${randomBytes(4).toString("hex")}` }),
  })).json() as { id: string; firstSession: { id: string } };
  return { request, project };
}

test("a malformed package answers 4xx on both package endpoints, not 500", async (context) => {
  const { request, project } = await fixture(context);
  const target = await project();
  const archive = archiveBytes();
  assert.equal(archive.subarray(0, 2).toString("hex"), "1f8b", "the base archive is a gzip stream");

  const endpoints = [
    { name: "inspect", path: `/api/projects/${target.id}/research-package/inspect`, method: "POST" },
    { name: "import", path: `/api/projects/${target.id}/research-package/import?sessionId=${target.firstSession.id}`, method: "POST" },
  ];
  // A gzipped folder is the "simply the wrong file" case: the decompressor is
  // happy and the parser refuses the archive's own structure, which no zlib code
  // would classify.
  const wrongFile = { name: "a gzipped folder, not a package", bytes: archiveWithDirectoryEntry() };
  for (const payload of [...malformedPayloads(archive), wrongFile]) {
    for (const endpoint of endpoints) {
      const response = await request(endpoint.path, { method: endpoint.method, body: payload.bytes });
      const body = await response.json() as { code?: string; error?: string };
      const where = `${endpoint.name}: ${payload.name}`;
      assert.equal(response.status, 400, `${where} answered ${response.status} ${JSON.stringify(body)}`);
      assert.ok([RESEARCH_PACKAGE_INVALID_CODE, RESEARCH_PACKAGE_TRUNCATED_CODE].includes(body.code ?? ""), `${where} code=${body.code}`);
      assert.match(body.error ?? "", /not a valid research package/u, where);
      assert.doesNotMatch(body.error ?? "", /Internal server error/u, where);
    }
  }
});