// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import {
  cleanLabel,
  createPermissionEpoch,
  parsePermissionAuthorization,
  permissionMatcherResource,
} from "./permission-policy.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

test("permission policy normalizes labels and preserves a frozen network snapshot", () => {
  const network = { mode: "domain-allowlist" as const, allowedDomains: ["example.org"], allowPrivateNetwork: false, egressProxyPolicy: "inherit" as const, revision: "rev-1" };
  const epoch = createPermissionEpoch("session-1", "  user   approved   run  ", undefined, undefined, network);
  assert.equal(epoch.reason, "user approved run");
  assert.equal(epoch.networkPolicy, "domain-allowlist");
  assert.deepEqual(epoch.networkAccess, network);
  network.allowedDomains.push("mutated.example.org");
  assert.deepEqual(epoch.networkAccess.allowedDomains, ["example.org"]);
});

test("permission matching uses action-specific resource identity", () => {
  assert.equal(permissionMatcherResource("connector", "connector:arxiv:search"), "connector:arxiv");
  assert.equal(permissionMatcherResource("artifact_download", "artifact:arxiv:paper-1:workspace:paper.pdf"), "artifact:arxiv");
  assert.equal(permissionMatcherResource("remote_job", "remote_job:runner-1:job-1:session-1"), "remote_job:runner-1:job-1");
  assert.equal(permissionMatcherResource("code", "workspace:project-1:session-1"), "workspace:project-1:session-1");
});

test("permission authorization keeps current sources and upgrades legacy never-ask", () => {
  const current = parsePermissionAuthorization(JSON.stringify({
    action: "shell", resource: "workspace", source: "always_allow", scope: "session",
  }));
  assert.equal(current.source, "always_allow");
  const legacy = parsePermissionAuthorization(JSON.stringify({
    action: "shell", resource: "workspace", source: "never_ask", scope: "session",
  }));
  assert.equal(legacy.source, "always_allow");
});

test("cleanLabel supplies a fallback and bounds oversized reasons", () => {
  assert.equal(cleanLabel(" \t\n ", "Session created"), "Session created");
  assert.equal(cleanLabel("x".repeat(200), "fallback").length, 120);
});

