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
import { test } from "node:test";

/** Contract tests for the shared sandbox network policy logic in @science-agent/schema. */

import {
  allowedDomainMatches,
  epochSandboxNetworkAccess,
  normalizeAllowedDomains,
  parseAllowedDomain,
  type PermissionEpoch,
} from "@science-agent/schema";

test("allowed domain entries are normalized, de-duplicated and sorted", () => {
  assert.deepEqual(
    normalizeAllowedDomains([" Example.ORG ", "*.example.org", "example.org", "api.example.org:443"]),
    ["*.example.org", "api.example.org:443", "example.org"],
  );
});

test("allowed domain entries reject IP literals, URLs and malformed hosts", () => {
  for (const entry of ["127.0.0.1", "10.0.0.5:8080", "https://example.org", "example.org/path", "example", "*.org"]) {
    assert.throws(() => parseAllowedDomain(entry), new RegExp(""), `expected ${entry} to be rejected`);
  }
  assert.throws(() => parseAllowedDomain("example.org:0"), /invalid port/);
});

test("exact entries match only the host itself", () => {
  const allowlist = ["example.org"];
  assert.equal(allowedDomainMatches(allowlist, "example.org", 443), true);
  assert.equal(allowedDomainMatches(allowlist, "EXAMPLE.org.", 80), true);
  assert.equal(allowedDomainMatches(allowlist, "api.example.org", 443), false);
  assert.equal(allowedDomainMatches(allowlist, "notexample.org", 443), false);
});

test("wildcard entries match at a label boundary only", () => {
  const allowlist = ["*.example.org"];
  assert.equal(allowedDomainMatches(allowlist, "api.example.org", 443), true);
  assert.equal(allowedDomainMatches(allowlist, "a.b.example.org", 443), true);
  // The apex is a separate grant, and a look-alike suffix must never match.
  assert.equal(allowedDomainMatches(allowlist, "example.org", 443), false);
  assert.equal(allowedDomainMatches(allowlist, "evil-example.org", 443), false);
  assert.equal(allowedDomainMatches(allowlist, "example.org.attacker.test", 443), false);
});

test("a port suffix restricts the entry to that port", () => {
  assert.equal(allowedDomainMatches(["example.org:443"], "example.org", 443), true);
  assert.equal(allowedDomainMatches(["example.org:443"], "example.org", 8080), false);
  assert.equal(allowedDomainMatches(["example.org"], "example.org", 8080), true);
});

test("IP targets never match a domain allowlist", () => {
  assert.equal(allowedDomainMatches(["example.org"], "127.0.0.1", 4310), false);
  assert.equal(allowedDomainMatches(["example.org"], "::1", 4310), false);
});

test("epochs without a policy snapshot read as no network", () => {
  const legacy = {
    createdAt: "2026-01-01T00:00:00.000Z",
    environmentRevisionId: "env",
    id: "epoch",
    mounts: [{ mode: "read-write", source: "workspace" }],
    networkPolicy: "none",
    reason: "Session created",
    secretRefs: [],
    sessionId: "session",
  } satisfies PermissionEpoch;
  assert.deepEqual(epochSandboxNetworkAccess(legacy), {
    allowPrivateNetwork: false,
    allowedDomains: [],
    mode: "none",
    revision: "none",
  });
});

test("a snapshot that disagrees with the epoch mode degrades to no network", () => {
  // Defensive: a hand-edited or partially migrated epoch must never widen access.
  assert.equal(epochSandboxNetworkAccess({
    networkAccess: { allowPrivateNetwork: false, allowedDomains: ["example.org"], mode: "domain-allowlist", revision: "abc" },
    networkPolicy: "none",
  }).mode, "none");
});
