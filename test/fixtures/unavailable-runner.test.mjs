// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createTest } from '../support/tagged/compat.mjs';
import { unavailableRunner } from './unavailable-runner.mjs';
const {test} = createTest(import.meta.url,{tags:['category:st','os:linux','arch:amd64','arch:arm64','model:none','tier:l2']});

test('real E2E fault Runner stays manageable but rejects execution before dispatch', async t => {
  const runner = await unavailableRunner();
  t.after(()=>runner.stop());
  const base = `http://${runner.endpoint.host}:${runner.endpoint.port}`;
  const headers = {authorization:`Bearer ${runner.token}`,'content-type':'application/json'};
  assert.equal((await fetch(`${base}/health`)).status,200);
  assert.equal((await fetch(`${base}/execution-capability`)).status,401);
  const result = await fetch(`${base}/execution-capability`,{method:'POST',headers});
  assert.equal(result.status,200);
  const capability = await result.json();
  assert.equal(capability.ready,false);
  assert.equal(capability.reason,'dependency-unavailable');
  const execute = await fetch(`${base}/execute-shell`,{method:'POST',headers,body:JSON.stringify({code:'printf should-not-run'})});
  assert.equal(execute.status,503);
  assert.match(JSON.stringify(await execute.json()),/EXECUTION_UNAVAILABLE/);
  assert.equal(runner.requests.filter(r=>r.path==='/execute-shell').length,1);
});
