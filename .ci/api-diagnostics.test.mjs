// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createTest } from "../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CI observers retain HTTP/memory/exit evidence without payloads or changing the exit code", async t => {
  const directory = await mkdtemp(join(tmpdir(), "api-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const module = new URL("./api-diagnostics.mjs", import.meta.url).href;
  const code = `
    import { startApiDiagnostics } from ${JSON.stringify(module)};
    import { createServer } from 'node:http';
    startApiDiagnostics(process.argv[1], { intervalMs: 20, slowRequestMs: 1 });
    const server = createServer((req, res) => setTimeout(() => res.end('private-body'), 30));
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const result = await fetch('http://127.0.0.1:' + server.address().port + '/api/sessions/fixture/runs?token=private-token');
    if (await result.text() !== 'private-body') process.exit(9);
    server.closeAllConnections(); await new Promise(done => server.close(done));
    await new Promise(done => setTimeout(done, 50));
    process.exitCode = 7;
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", code, directory], { stdio: "pipe" });
  let stderr = ""; child.stderr.on("data", bytes => { stderr += bytes; });
  const exit = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  assert.equal(exit, 7, stderr);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const text = await readFile(join(directory, files[0]), "utf8");
  assert.ok(!/private-body|private-token|\/runs/.test(text));
  const rows = text.trim().split("\n").map(JSON.parse);
  assert.ok(rows.some(row => row.heapUsed > 0 && row.rss > 0));
  assert.ok(rows.some(row => row.requests > 0 && row.slowRequests > 0));
  assert.ok(rows.some(row => row.runsRequests > 0 && row.runsMaxMs > 0));
  assert.equal(rows.at(-1).phase, "exit");
  assert.equal(rows.at(-1).code, 7);
});
