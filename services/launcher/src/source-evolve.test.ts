// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSourceEvolve } from "./source-evolve.js";

test("explicit source runtime uses the same owned socket, private credential and control lifecycle", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "source-evolve-test-"));
  const python = join(dataDir, "fixture-interpreter"); const stateFile = join(dataDir, "control.json");
  await writeFile(python, `#!${process.execPath}\nconst server=require('node:http').createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/health')return res.end('{"status":"healthy"}');if(req.headers.authorization!=='Bearer '+process.env.SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN){res.statusCode=401;return res.end('{}');}res.end('{"stopped":false}');});server.listen(0,'127.0.0.1',()=>console.log('EVOLVE_PORT='+server.address().port));\n`, { mode: 0o700 });
  let control: Awaited<ReturnType<typeof startSourceEvolve>> | undefined;
  try {
    control = await startSourceEvolve(python, dataDir, stateFile);
    assert.equal(control.runtime.status().state, "ready");
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    const env = JSON.parse(await readFile(stateFile, "utf8"));
    assert.match(env.SCIENCE_AGENT_EVOLVE_CONTROL_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert(env.SCIENCE_AGENT_EVOLVE_CONTROL_TOKEN !== control.runtime.connection()!.internalToken, "control and sidecar credentials have separate lifetimes");
    await control.close(); control = undefined;
    await assert.rejects(readFile(stateFile), { code: "ENOENT" });
    await assert.rejects(startSourceEvolve("/nonexistent/interpreter", dataDir, stateFile), /readiness/);
    await assert.rejects(startSourceEvolve(python, dataDir, join(dataDir, "missing-parent/control")));
  } finally { await control?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
