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

import { createTest } from "../../../test/support/tagged/compat.mjs";
import {
  domainEntries,
  proxyPolicyServerId,
  runnerStateLabel,
  runnerStateTone,
} from "../src/app/settings-format.js";

const { describe, it } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

describe("proxy policies", () => {
  it("reads the server id back out of a policy", () => {
    assert.equal(proxyPolicyServerId("proxy:p1"), "p1");
    assert.equal(proxyPolicyServerId("none"), undefined);
    assert.equal(proxyPolicyServerId("inherit"), undefined);
  });
});

describe("the allowlist box", () => {
  it("reads one entry per line, and a comma-separated paste as the same list", () => {
    assert.deepEqual(domainEntries("example.org\n*.example.org:443"), [
      "example.org",
      "*.example.org:443",
    ]);
    assert.deepEqual(domainEntries("a.example.org, b.example.org"), [
      "a.example.org",
      "b.example.org",
    ]);
  });

  it("drops blank lines and leaves the spelling to the service", () => {
    // The service lower-cases, sorts and de-duplicates; doing it here would be
    // a second opinion that could drift from what it accepts.
    assert.deepEqual(domainEntries("\n  \nExample.ORG\n\n"), ["Example.ORG"]);
    assert.deepEqual(domainEntries("   "), []);
  });
});

describe("runner state", () => {
  it("maps the states the runner reports", () => {
    assert.equal(runnerStateLabel("ready"), "就绪");
    assert.equal(runnerStateLabel("stopped"), "已停止");
    assert.equal(runnerStateTone("ready"), "ok");
    assert.equal(runnerStateTone("starting"), "warn");
  });

  it("treats a runner that never answered as absent rather than broken", () => {
    assert.equal(runnerStateTone(undefined), "off");
    assert.equal(runnerStateLabel(undefined), "这个 Runner 还没有回报过状态。");
  });

  it("passes an unrecognised state through with a warning tone", () => {
    assert.equal(runnerStateLabel("hibernating"), "hibernating");
    assert.equal(runnerStateTone("hibernating"), "warn");
  });
});
